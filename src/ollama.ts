import { ChatOllama } from '@langchain/ollama';
import { createAgent } from 'langchain';
import type { Input } from './relay.ts';

const baseUrl = 'http://127.0.0.1:11434';

export async function createOllamaResponder(model: string, shutdown: AbortSignal) {
  const response = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.any([shutdown, AbortSignal.timeout(5_000)]),
  }).catch(() => { throw new Error('Start the local Ollama server on port 11434'); });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Ollama model unavailable. Run ollama pull ${model}`);

  const agent = createAgent({
    model: new ChatOllama({ baseUrl, model, think: false, temperature: 0, numCtx: 16384, maxRetries: 0 }),
    tools: [],
    systemPrompt: 'You are a concise assistant replying over iMessage. Use the supplied conversation to understand follow-ups. Answer in plain text.',
  });

  return async ({ text, history }: Input) => {
    const messages = (history ?? []).flatMap(turn => [
      { role: 'user' as const, content: turn.user },
      { role: 'assistant' as const, content: turn.assistant },
    ]);
    const result = await agent.invoke({ messages: [...messages, { role: 'user', content: text }] }, {
      signal: AbortSignal.any([shutdown, AbortSignal.timeout(120_000)]),
    });
    const answer = result.messages.at(-1)?.text.trim().slice(0, 8000);
    if (!answer) throw new Error('Ollama returned an empty answer');
    return answer;
  };
}
