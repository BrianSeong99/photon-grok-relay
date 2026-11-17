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
