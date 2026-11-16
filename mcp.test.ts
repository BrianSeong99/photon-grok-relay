import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { replyServer } from './mcp.ts';

test('requires authentication and completes a real MCP handshake and reply call', async () => {
  const secret = randomUUID();
  const calls: string[][] = [];
  const server = replyServer(secret, async (id, text) => {
    calls.push([id, text]);
    return 'captured';
  });
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  const url = new URL('/mcp', address);
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  try {
    for (const headers of [new Headers(), new Headers({ Authorization: 'Bearer wrong' })]) {
      assert.equal((await fetch(url, { method: 'POST', headers })).status, 401);
    }
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['reply_to_message']);
    const requestId = randomUUID();
    const result = await client.callTool({ name: 'reply_to_message', arguments: { requestId, text: 'answer' } });
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [[requestId, 'answer']]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('health and readiness report distinct states', async () => {
  let ready = false;
  const server = replyServer('test-secret', async () => 'captured', () => ready);
  try {
    assert.equal((await server.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    assert.equal((await server.inject({ method: 'GET', url: '/readyz' })).statusCode, 503);
    ready = true;
    assert.equal((await server.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
  } finally {
    await server.close();
  }
});
