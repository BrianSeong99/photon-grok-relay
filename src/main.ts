import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Relay, type Input } from './relay.ts';
import { replyServer } from './server.ts';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const mode = process.env.RELAY_MODE ?? 'capture';
  if (mode !== 'capture' && mode !== 'imessage') throw new Error('Invalid RELAY_MODE');
  const projectId = mode === 'imessage' ? required('PHOTON_PROJECT_ID') : '';
  const projectSecret = mode === 'imessage' ? required('PHOTON_PROJECT_SECRET') : '';
  const allowedSender = mode === 'imessage' ? required('TEST_SENDER') : '';
  if (mode === 'imessage' && (projectId.startsWith('pho_prj_') || !/^\+[1-9]\d{7,14}$/.test(allowedSender))) {
    throw new Error('Requires a legacy Spectrum project and an E.164 test sender');
  }
  const backend = process.env.RELAY_BACKEND ?? 'grok';
  if (backend !== 'grok' && backend !== 'ollama') throw new Error('Invalid RELAY_BACKEND');
  const model = backend === 'ollama' ? process.env.OLLAMA_MODEL || 'qwen3.5:9b' : undefined;
  const logFile = process.env.RELAY_LOG_FILE || 'relay.log';
  appendFileSync(logFile, '', { mode: 0o600 });
  function log(event: string, fields: { id?: string; durationMs?: number } = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), backend, model, event, ...fields });
    console.log(line);
    try {
      appendFileSync(logFile, line + '\n', { mode: 0o600 });
    } catch {
      console.error('Could not append to the relay log');
    }
  }
  const shutdown = new AbortController();
  let trigger: (input: Input) => Promise<string | void>;
  let bearer: string | undefined;
  if (model) {
    const { createOllamaResponder } = await import('./ollama.ts');
    const generate = await createOllamaResponder(model, shutdown.signal);
    trigger = async input => {
      const started = performance.now();
      log('generation_started', { id: input.requestId });
      try {
        const answer = await generate(input);
        log('generation_finished', { id: input.requestId, durationMs: Math.round(performance.now() - started) });
        return answer;
      } catch (error) {
        log('generation_failed', { id: input.requestId, durationMs: Math.round(performance.now() - started) });
        throw error;
      }
    };
  } else {
    const webhook = new URL(required('GROK_ROUTINE_URL'));
    if (webhook.origin !== 'https://api2.cursor.sh') throw new Error('Unexpected routine endpoint');
    const routineKey = required('GROK_ROUTINE_KEY');
    bearer = required('MCP_BEARER');
    if (bearer.length < 32) throw new Error('MCP_BEARER must have at least 32 characters');
    trigger = async input => {
      const response = await fetch(webhook, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${routineKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200) throw new Error('Routine request failed');
      await response.body?.cancel();
    };
  }

  process.umask(0o077);
  const relay = new Relay(process.env.RELAY_DB ?? 'relay.sqlite', trigger,
    Date.now, (id, state) => log(state, { id }));

  let ready = false;
  const server = replyServer(bearer, (id, text) => relay.reply(id, text), () => ready);
  let stopInput: (() => Promise<void> | void) | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    ready = false;
    shutdown.abort();
    closing = Promise.allSettled([server.close(), Promise.resolve().then(() => stopInput?.())])
      .then(results => {
        if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
      });
    return closing;
  }
  const onSignal = () => { void close(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await server.listen({ port: Number(process.env.RELAY_PORT ?? 8787), host: '127.0.0.1' });
    log('http_listening');
    if (shutdown.signal.aborted) return;

    if (mode === 'capture') {
      const lines = createInterface({ input: process.stdin, terminal: false });
      stopInput = () => lines.close();
      ready = true;
      log('capture_ready');
      for await (const line of lines) {
        if (shutdown.signal.aborted) break;
        if (line.trim()) await relay.receive(randomUUID(), 'capture', line.trim());
      }
      if (!shutdown.signal.aborted) await new Promise<void>(resolve => {
        shutdown.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }

    const [{ Spectrum }, { imessage }] = await Promise.all([
      import('spectrum-ts'),
      import('spectrum-ts/providers/imessage'),
    ]);
    const app = await Spectrum({
      projectId,
      projectSecret,
      providers: [imessage.config()],
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]),
    });
    stopInput = () => app.stop();
    if (shutdown.signal.aborted) {
      await app.stop();
      return;
    }
    ready = true;
    log('photon_ready');
    console.log('Spectrum connected. Waiting for a direct text.');
    for await (const [space, message] of app.messages) {
      if (shutdown.signal.aborted) break;
      if (space.__platform !== 'imessage' || !('type' in space) || space.type !== 'dm') continue;
      if (message.direction !== 'inbound' || message.content.type !== 'text') continue;
      if (message.sender?.id !== allowedSender || !message.content.text.trim()) continue;
      await relay.receive(message.id, space.id, message.content.text, async answer => {
        await space.send(answer);
      }, backend === 'ollama' ? generate => space.responding(generate) : undefined);
    }
    if (!shutdown.signal.aborted) throw new Error('Spectrum message stream ended');
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    await close();
    log('relay_stopped');
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Start the local Ollama server|Ollama model unavailable)/.test(message)
    ? message : 'Relay stopped. Check local configuration and connection status.');
  process.exit(1);
});
