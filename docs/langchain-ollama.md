# Text a local LangChain agent

Choose the Ollama backend to send iMessages to a LangChain agent running on your Mac. Photon still delivers the messages. LangChain calls Ollama on loopback and returns the answer directly to the relay.

1. Start Ollama with `ollama serve` if it is stopped. In a separate terminal, run `ollama pull qwen3.5:9b`.
2. Run `npm ci`. Set `RELAY_BACKEND=ollama` and `OLLAMA_MODEL=qwen3.5:9b` in your local `.env`.
3. Run `RELAY_MODE=capture npm start`. Type a first message and wait for the `captured` status before sending a follow-up. Inspect the answers with the SQLite command in the [README](../README.md#2-connect-grok-bot-and-capture-two-replies).
4. Stop the capture process. Configure a Photon Stable project and test sender as described in the [README](../README.md#3-connect-photon-spectrum-cloud). Run `RELAY_MODE=imessage npm start`. Run only one relay against the test line during the demo.
5. Text the assigned Photon number. While Ollama generates an answer, the relay uses Spectrum's `space.responding()` to show iMessage typing. The indicator clears when generation finishes or fails. Ask a follow-up and confirm it uses the previous answer.

No model API key, Grok Bot routine, MCP connector, or public tunnel is required in Ollama mode. Recent context is held in memory and supplied to LangChain on each turn. The relay continues to filter inbound texts by the configured test sender. It loads the model on demand, so the first reply may take longer. The Mac must be awake and both processes must be running.

[LangChain ChatOllama integration](https://docs.langchain.com/oss/javascript/integrations/chat/ollama) · [Qwen 3.5 9B](https://ollama.com/library/qwen3.5:9b)
