import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Relay } from './relay.ts';
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
  const webhook = new URL(required('GROK_ROUTINE_URL'));
  if (webhook.origin !== 'https://api2.cursor.sh') throw new Error('Unexpected routine endpoint');
  const routineKey = required('GROK_ROUTINE_KEY');
  const bearer = required('MCP_BEARER');
  if (bearer.length < 32) throw new Error('MCP_BEARER must have at least 32 characters');

  process.umask(0o077);
  const relay = new Relay(process.env.RELAY_DB ?? 'relay.sqlite', async input => {
    const response = await fetch(webhook, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${routineKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200) throw new Error('Routine request failed');
    await response.body?.cancel();
  }, Date.now, (id, state) => console.log(JSON.stringify({ id, state, at: new Date().toISOString() })));

  let ready = false;
  const shutdown = new AbortController();
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
    console.log(`Reply endpoint listening locally in ${mode} mode`);
    if (shutdown.signal.aborted) return;

    if (mode === 'capture') {
      const lines = createInterface({ input: process.stdin, terminal: false });
      stopInput = () => lines.close();
      ready = true;
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
    console.log('Spectrum connected. Waiting for a direct text.');
    for await (const [space, message] of app.messages) {
      if (shutdown.signal.aborted) break;
      if (space.__platform !== 'imessage' || !('type' in space) || space.type !== 'dm') continue;
      if (message.direction !== 'inbound' || message.content.type !== 'text') continue;
      if (message.sender?.id !== allowedSender || !message.content.text.trim()) continue;
      await relay.receive(message.id, space.id, message.content.text, async answer => {
        await space.send(answer);
      });
    }
    if (!shutdown.signal.aborted) throw new Error('Spectrum message stream ended');
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    await close();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

main().catch(() => {
  console.error('Relay stopped. Check local configuration and connection status.');
  process.exit(1);
});
