import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Relay } from '../src/relay.ts';

test('correlates replies and suppresses duplicates', async () => {
  const inputs: string[] = [];
  const sent: string[] = [];
  const relay = new Relay(':memory:', async (input) => { inputs.push(input.requestId); });
  const receive = () => relay.receive('event-1', 'chat-1', 'hello', async text => { sent.push(text); });
  await receive();
  await receive();
  assert.equal(inputs.length, 1);
  assert.equal(await relay.reply('bogus', 'answer'), 'unknown');
  assert.equal(await relay.reply(inputs[0], 'answer'), 'sent');
  assert.equal(await relay.reply(inputs[0], 'answer'), 'duplicate');
  assert.deepEqual(sent, ['answer']);
});

test('expires requests and avoids retrying ambiguous sends', async () => {
  let now = 0;
  let id = '';
  const relay = new Relay(':memory:', async (input) => { id = input.requestId; }, () => now);
  await relay.receive('event-1', 'chat', 'hello');
  now = 180_001;
  assert.equal(await relay.reply(id, 'answer'), 'expired');
  await relay.receive('event-2', 'chat', 'hello', async () => { throw new Error('timeout'); });
  assert.equal(await relay.reply(id, 'answer'), 'send_unknown');
  assert.equal(await relay.reply(id, 'answer'), 'duplicate');
});

test('queues a follow-up until the current reply finishes', async () => {
  const ids: string[] = [];
  const histories: unknown[] = [];
  const relay = new Relay(':memory:', async input => { ids.push(input.requestId); histories.push(input.history); });
  await relay.receive('1', 'chat', 'first');
  await relay.receive('2', 'chat', 'second');
  assert.equal(ids.length, 1);
  assert.equal(await relay.reply(ids[0], 'first answer'), 'captured');
  assert.equal(ids.length, 2);
  assert.deepEqual(histories[1], [{ user: 'first', assistant: 'first answer' }]);
});

test('direct answers show typing during generation and clear it before sending', async () => {
  const events: string[] = [];
  const relay = new Relay(':memory:', async () => {
    events.push('generate');
    return 'answer';
  });
  await relay.receive('event', 'chat', 'question', async answer => { events.push(answer); }, {
    start: async () => { events.push('typing:start'); },
    stop: async () => { events.push('typing:stop'); },
  });
  assert.deepEqual(events, ['typing:start', 'generate', 'typing:stop', 'answer']);
});

test('Grok keeps typing after the webhook is accepted and clears it before the reply', async () => {
  const events: string[] = [];
  const relay = new Relay(':memory:', async () => { events.push('webhook accepted'); });
  const id = await relay.receive('event', 'chat', 'question', async answer => { events.push(answer); }, {
    start: async () => { events.push('typing:start'); },
    stop: async () => { events.push('typing:stop'); },
  });
  assert(id);
  assert.deepEqual(events, ['typing:start', 'webhook accepted']);
  assert.equal(await relay.reply(id, 'answer'), 'sent');
  assert.deepEqual(events, ['typing:start', 'webhook accepted', 'typing:stop', 'answer']);
});

test('clears typing on timeout and trigger failure', async () => {
  const events: string[] = [];
  let now = 0;
  const relay = new Relay(':memory:', async input => {
    if (input.text === 'fail') throw new Error('request failed');
  }, () => now);
  const typing = {
    start: async () => { events.push('start'); },
    stop: async () => { events.push('stop'); },
  };
  const id = await relay.receive('one', 'chat', 'wait', undefined, typing);
  assert(id);
  now = 180_001;
  assert.equal(await relay.reply(id, 'late'), 'expired');
  await relay.receive('two', 'chat', 'fail', undefined, typing);
  assert.deepEqual(events, ['start', 'stop', 'start', 'stop']);
});

test('intercepts commands before either backend and isolates model history', async () => {
  const seen: Array<{ backend: unknown; history: unknown }> = [];
  const replies: string[] = [];
  const relay = new Relay(':memory:', async (input, backend) => {
    seen.push({ backend, history: input.history });
    return input.text;
  }, Date.now, undefined, { defaultBackend: 'grok', available: ['grok', 'ollama'] });
  const send = async (text: string) => { replies.push(text); };
  await relay.receive('1', 'chat', 'hosted question', send);
  await relay.receive('2', 'chat', '/ollama', send);
  await relay.receive('2', 'chat', '/ollama', send);
  await relay.receive('3', 'chat', '/backend', send);
  await relay.receive('4', 'chat', '/help', send);
  await relay.receive('5', 'chat', '/unknown', send);
  await relay.receive('6', 'chat', 'local question', send);
  await relay.receive('7', 'chat', '/grok', send);
  await relay.receive('8', 'chat', 'hosted follow-up', send);
  await relay.receive('9', 'chat', '/reset', send);
  await relay.receive('10', 'chat', 'fresh hosted question', send);
  assert.deepEqual(seen, [
    { backend: 'grok', history: undefined },
    { backend: 'ollama', history: undefined },
    { backend: 'grok', history: [{ user: 'hosted question', assistant: 'hosted question' }] },
    { backend: 'grok', history: undefined },
  ]);
  assert.equal(replies.filter(text => text === 'Switched to Ollama.').length, 1);
});

test('keeps formatted and malformed slash commands out of backend requests and history', async () => {
  const inputs: Array<{ text: string; history: unknown }> = [];
  const replies: string[] = [];
  const relay = new Relay(':memory:', async ({ text, history }) => {
    inputs.push({ text, history });
    return 'answer';
  });
  const send = async (text: string) => { replies.push(text); };

  await relay.receive('1', 'chat', 'first question', send);
  await relay.receive('2', 'chat', ' \u200b／BACKEND\u2060 ', send);
  await relay.receive('3', 'chat', '/backend?', send);
  await relay.receive('4', 'chat', '/reset extra', send);
  await relay.receive('5', 'chat', 'What does /backend show?', send);

  assert.deepEqual(inputs, [
    { text: 'first question', history: undefined },
    { text: 'What does /backend show?', history: [{ user: 'first question', assistant: 'answer' }] },
  ]);
  assert.deepEqual(replies, [
    'answer',
    'Active backend: Grok Bot.',
    'Unknown command. Text /help for commands.',
    'Unknown command. Text /help for commands.',
    'answer',
  ]);
});

test('persists selection and keeps in-flight work on its original backend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-routing-'));
  try {
    const db = join(dir, 'relay.sqlite');
    const config = { defaultBackend: 'grok', available: ['grok', 'ollama'] } as const;
    const routing = { ...config, available: [...config.available] };
    const backends: string[] = [];
    const trigger: ConstructorParameters<typeof Relay>[1] = async (_input, backend) => {
      backends.push(backend);
      return backend === 'ollama' ? 'local answer' : undefined;
    };
    const relay = new Relay(db, trigger, Date.now, undefined, routing);
    const send = async () => {};
    const first = await relay.receive('a', 'chat', 'first', send);
    assert(first);
    await relay.receive('b', 'chat', '/ollama', send);
    await relay.receive('c', 'chat', 'next', send);
    assert.deepEqual(backends, ['grok']);
    assert.equal(await relay.replyFromGrok(first, 'grok answer'), 'sent');
    const restarted = new Relay(db, trigger, Date.now, undefined, routing);
    await restarted.receive('d', 'chat', 'after restart', send);
    assert.deepEqual(backends, ['grok', 'ollama', 'ollama']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
