# Relay runtime behavior

The queue processes one active turn across the process. SQLite records inbound event IDs and delivery state. The active send function, queued jobs, and recent chat history live in memory.

## Request states

| State | Meaning |
| --- | --- |
| `queued` | A new inbound event was stored and is waiting for the current turn to finish. Repeated event IDs are ignored. |
| `pending` | The turn is active. Grok mode waits for a callback and Ollama mode generates a reply locally. It expires after three minutes. |
| `captured` | The answer was stored locally in capture mode. |
| `sending` | The relay claimed the answer and started the Spectrum send. |
| `sent` | The Spectrum send call resolved. Check the phone to confirm delivery. |
| `expired` | The callback window elapsed. A late callback cannot send a reply. |
| `trigger_unknown` | Backend work failed or timed out. For Grok, inspect the Bot before retrying. For Ollama, check for `generation_failed` and inspect the local model server. |
| `send_unknown` | A send may have reached Photon before failing, or the process stopped during a send. Check Messages before retrying. |
| `interrupted` | A restart found this turn queued or pending. A restart does not replay outstanding work. |

A second callback for a claimed request is treated as a duplicate. The tool returns an error for unknown or expired requests.

## Backend switching

Run in `RELAY_BACKEND=both` with the Grok routine and callback credentials set and Ollama running locally. Grok is the default for new threads. A successful `/grok` or `/ollama` saves the selection by chat ID in SQLite. A command is handled after sender verification and before generation, and the relay replies directly.

A normal message keeps the backend selected when it arrived, even if it is still queued when you switch. `/reset` clears relay history for this chat and active backend. It does not clear the Grok Bot app transcript. The selected backend persists when the relay restarts. Its recent history does not.

## Follow-up context

The relay retains up to four successful exchanges per conversation and passes them to the backend on the next turn. Each user message and answer in that history is limited to 4,000 characters. The first turn has no relay history. A restart clears this history, even though SQLite retains the request statuses.

## Check each part of the flow

With the relay running, use the local endpoints to distinguish server startup from input initialization:

```sh
curl -i http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8787/readyz
```

1. **Local tests.** Run `npm run check` and `npm test`. The tests exercise the server and relay with controlled inputs. They establish local behavior.
2. **Live callback.** Use the [Grok Bot capture test](grok-bot.md#2-connect-grok-bot-and-capture-two-replies). Confirm both replies reach `captured` and the second refers to the first.
3. **Phone test.** Use the [Grok Bot](grok-bot.md#3-connect-photon-and-text-the-relay) or [Ollama](langchain-ollama.md#3-text-your-agent) iMessage test. Confirm each answer appears once in the same thread.

If Grok Bot answers but the request later becomes `expired`, check the connector URL and bearer credential. A restarted Quick Tunnel uses a new URL. If the relay shows `sent` but Messages is silent, investigate delivery on the Photon side.

For local generation and persistent logs, follow the [Ollama monitoring guide](langchain-ollama.md#monitor-the-relay).
