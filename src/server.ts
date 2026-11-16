import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export function replyServer(secret: string, reply: (id: string, text: string) => Promise<string>, isReady = () => true) {
  const expected = Buffer.from('Bearer ' + secret);
  const server = Fastify({ exposeHeadRoutes: false });
  server.get('/healthz', async () => ({ status: 'ok' }));
  server.get('/readyz', async (_req, res) => {
    const ready = isReady();
    return res.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });

  server.all('/mcp', {
    onRequest: async (req, res) => {
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return res.code(401).send();
      }
      if (req.method !== 'POST') {
        return res.header('Allow', 'POST').code(405).send();
      }
    },
  }, async (req, res) => {
    res.hijack();
    const raw = res.raw;
    const mcp = new McpServer({ name: 'photon-relay', version: '1.0.0' });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    mcp.registerTool('reply_to_message', {
      description: 'Return the answer to a pending relay request. In iMessage mode this sends to the original conversation.',
      inputSchema: {
        requestId: z.uuid(),
        text: z.string().trim().min(1).max(8000),
      },
    }, async ({ requestId, text }) => {
      const result = await reply(requestId, text);
      return {
        isError: !['sent', 'captured', 'duplicate'].includes(result),
        content: [{ type: 'text', text: result }],
      };
    });
    raw.once('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req.raw, raw, req.body);
    } catch {
      if (!raw.headersSent) raw.writeHead(500);
      raw.end();
    }
  });
  return server;
}
