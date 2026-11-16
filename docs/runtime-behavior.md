# Relay runtime behavior

The queue processes one active turn across the process. SQLite records inbound event IDs and delivery state. The active send function, queued jobs, and recent chat history live in memory.

## Request states

| State | Meaning |
| --- | --- |
| `queued` | A new inbound event was stored and is waiting for the current turn to finish. Repeated event IDs are ignored. |
| `pending` | The turn is active and can receive a callback. It expires after three minutes. |
| `captured` | The callback answer was stored locally in capture mode. |
| `sending` | The relay claimed the callback and started the Spectrum send. |
| `sent` | The Spectrum send call resolved. Check the phone to confirm delivery. |
| `expired` | The callback window elapsed. A late callback cannot send a reply. |
| `trigger_unknown` | The routine trigger failed or timed out. Inspect the Bot before repeating the request. |
| `send_unknown` | A send may have reached Photon before failing, or the process stopped during a send. Check Messages before retrying. |
| `interrupted` | A restart found this turn queued or pending. A restart does not replay outstanding work. |

A second callback for a claimed request is treated as a duplicate. The tool returns an error for unknown or expired requests.

## Follow-up context

The relay retains up to four successful exchanges per conversation and includes them in the next routine payload. Each user message and answer in that history is limited to 4,000 characters. The first turn has no relay history. A restart clears this history, even though SQLite retains the request statuses.

## Check each part of the flow

With the relay running, use the local endpoints to distinguish server startup from input initialization:

```sh
curl -i http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8787/readyz
```

1. **Local tests.** Run `npm run check` and `npm test`. The tests exercise the server and relay with controlled inputs. They establish local behavior.
2. **Live callback.** Use the [README capture test](../README.md#2-connect-grok-bot-and-capture-two-replies). Confirm both replies reach `captured` and the second refers to the first.
3. **Phone test.** Use the [README iMessage test](../README.md#4-text-the-relay). Confirm each answer appears once in the same thread.

If Grok Bot answers but the request later becomes `expired`, check the connector URL and bearer credential. A restarted Quick Tunnel uses a new URL. If the relay shows `sent` but Messages is silent, investigate delivery on the Photon side.
