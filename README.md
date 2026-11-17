# Photon iMessage Relay

Text a Photon-managed number and get an answer in the same iMessage thread. A local TypeScript relay connects Photon Spectrum Cloud to the agent you choose.

## Choose a tutorial

| Tutorial | Where the answer comes from | What you need |
| --- | --- | --- |
| [Grok Bot](docs/grok-bot.md) | Your existing hosted Grok Bot. The relay starts a webhook routine and receives the answer through an MCP callback. | Grok Bot and an HTTPS callback tunnel. |
| [LangChain + Ollama](docs/langchain-ollama.md) | A LangChain agent in the relay calls Qwen 3.5 9B through Ollama on your Mac. | Ollama and the downloaded model. No public callback tunnel or model API key. |

Both tutorials use [Photon Stable](docs/photon-setup.md) for the iPhone test. Start with capture mode to verify your chosen backend from the terminal before connecting Photon.

## How the relay works

1. **Receive.** Photon delivers the incoming text over the Spectrum SDK stream.
2. **Respond.** The relay accepts direct texts from your test sender and passes recent turns from that thread to the selected backend. The Ollama path also shows iMessage typing while the model generates.
3. **Deliver.** The relay sends the answer back through Photon to the originating conversation. Fastify serves health checks, and the relay writes operational events to a local log.

For a code walkthrough, see the [architecture](docs/architecture.md). For request states, retries, and troubleshooting, see [runtime behavior](docs/runtime-behavior.md).

## Grok Bot demo

<img src="media/imessage-demo.gif" width="360" alt="Grok Bot replies to iMessages about an X profile and Tokyo weather">

The clip shows the Grok Bot path. [See both recordings](docs/grok-bot.md#recordings).
