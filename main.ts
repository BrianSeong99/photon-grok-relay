import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Relay } from './relay.ts';
import { replyServer } from './mcp.ts';

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

  const server = replyServer(bearer, (id, text) => relay.reply(id, text));
  server.listen(Number(process.env.RELAY_PORT ?? 8787), '127.0.0.1');
  await once(server, 'listening');
  console.log(`Reply endpoint listening locally in ${mode} mode`);

  if (mode === 'capture') {
    const lines = createInterface({ input: process.stdin, terminal: false });
    for await (const line of lines) {
      if (line.trim()) await relay.receive(randomUUID(), 'capture', line.trim());
    }
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
    signal: AbortSignal.timeout(30_000),
  });
  console.log('Spectrum connected. Waiting for a direct text.');
  for await (const [space, message] of app.messages) {
    if (space.__platform !== 'imessage' || !('type' in space) || space.type !== 'dm') continue;
    if (message.direction !== 'inbound' || message.content.type !== 'text') continue;
    if (message.sender?.id !== allowedSender || !message.content.text.trim()) continue;
    await relay.receive(message.id, space.id, message.content.text, async answer => {
      await space.send(answer);
    });
  }
  throw new Error('Spectrum message stream ended');
}

main().catch(() => {
  console.error('Relay stopped. Check local configuration and connection status.');
  process.exit(1);
});
