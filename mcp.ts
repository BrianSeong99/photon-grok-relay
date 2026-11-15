import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export function replyServer(secret: string, reply: (id: string, text: string) => Promise<string>) {
  const expected = Buffer.from('Bearer ' + secret);
  return createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
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
    res.once('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
