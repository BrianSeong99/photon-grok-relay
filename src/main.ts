import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Relay, type Backend, type Input } from './relay.ts';
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
  const modeBackend = process.env.RELAY_BACKEND ?? 'grok';
  if (modeBackend !== 'grok' && modeBackend !== 'ollama' && modeBackend !== 'both') {
    throw new Error('Invalid RELAY_BACKEND');
  }
  const model = modeBackend === 'grok' ? undefined : process.env.OLLAMA_MODEL || 'qwen3.5:9b';
  const logFile = process.env.RELAY_LOG_FILE || 'relay.log';
  appendFileSync(logFile, '', { mode: 0o600 });
  function log(event: string, fields: { id?: string; durationMs?: number; backend?: Backend } = {}) {
    const backend = fields.backend ?? modeBackend;
    const line = JSON.stringify({
      at: new Date().toISOString(), backend, model: backend === 'ollama' ? model : undefined, event, id: fields.id, durationMs: fields.durationMs,
    });
    console.log(line);
    try {
      appendFileSync(logFile, line + '\n', { mode: 0o600 });
    } catch {
      console.error('Could not append to the relay log');
    }
  }

  const shutdown = new AbortController();
  const backends: Partial<Record<Backend, (input: Input) => Promise<string | void>>> = {};
  let bearer: string | undefined;
  if (model) {
    const { createOllamaResponder } = await import('./ollama.ts');
    const generate = await createOllamaResponder(model, shutdown.signal);
    backends.ollama = async input => {
      const started = performance.now();
      const fields = { id: input.requestId, backend: 'ollama' as const };
      log('generation_started', fields);
      try {
        const answer = await generate(input);
        log('generation_finished', { ...fields, durationMs: Math.round(performance.now() - started) });
        return answer;
      } catch (error) {
        log('generation_failed', { ...fields, durationMs: Math.round(performance.now() - started) });
        throw error;
      }
    };
  }
  if (modeBackend !== 'ollama') {
    const webhook = new URL(required('GROK_ROUTINE_URL'));
    if (webhook.origin !== 'https://api2.cursor.sh') throw new Error('Unexpected routine endpoint');
    const routineKey = required('GROK_ROUTINE_KEY');
    bearer = required('MCP_BEARER');
    if (bearer.length < 32) throw new Error('MCP_BEARER must have at least 32 characters');
    backends.grok = async input => {
      const response = await fetch(webhook, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${routineKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel();
      if (response.status !== 200) throw new Error('Routine request failed');
      log('routine_accepted', { id: input.requestId, backend: 'grok' });
    };
  }

  process.umask(0o077);
  const relay = new Relay(process.env.RELAY_DB ?? 'relay.sqlite', async (input, backend) => {
    const trigger = backends[backend];
    if (!trigger) throw new Error('Backend unavailable');
    return trigger(input);
  }, Date.now, (id, state, backend) => log(state, { id, backend }), {
    defaultBackend: modeBackend === 'ollama' ? 'ollama' : 'grok',
    available: modeBackend === 'both' ? ['grok', 'ollama'] : [modeBackend],
    describe: async backend => {
      if (backend === 'grok') return 'Routine configured. Callback delivery is confirmed on the next reply.';
      const response = await fetch('http://127.0.0.1:11434/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      await response?.body?.cancel();
      return response?.ok ? `${model} is available locally.` : 'Local model is unavailable.';
    },
  });

  let ready = false;
  const server = replyServer(bearer, (id, text) => relay.replyFromGrok(id, text), () => ready);
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
      void relay.receive(message.id, space.id, message.content.text, async answer => {
        await space.send(answer);
      }, { start: () => space.startTyping(), stop: () => space.stopTyping() }).catch(() => log('input_failed'));
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
