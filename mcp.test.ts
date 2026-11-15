import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
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
    server.close();
  }
});
