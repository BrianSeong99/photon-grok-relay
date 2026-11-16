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
