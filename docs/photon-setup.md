# Configure Photon Stable for iMessage

Use a Photon Stable (Spectrum Cloud) project with iMessage enabled. These commands use Photon CLI `2.3.0`, the Stable-compatible line published under npm’s `legacy` tag. This code uses Spectrum’s project ID and project secret. A Photon 2.0 project ID beginning with `pho_prj_` requires a separate integration.

```sh
npx @photon-ai/cli@2.3.0 login
npx @photon-ai/cli@2.3.0 projects list --json
# If you need a new project:
npx @photon-ai/cli@2.3.0 projects create --name "Photon iMessage Relay" --platforms imessage --json
```

Register your iPhone number as the test sender using E.164 format. Replace the placeholders with your own values.

```sh
npx @photon-ai/cli@2.3.0 spectrum users add \
  --project '<PROJECT_ID>' --phone '<YOUR_E164_NUMBER>' \
  --first-name '<FIRST_NAME>' --last-name '<LAST_NAME>' --email '<YOUR_EMAIL>' --json
```

Save the returned `assignedPhoneNumber` for the phone test. Set `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, and `TEST_SENDER` in `.env`. The legacy CLI command `npx @photon-ai/cli@2.3.0 projects secret '<PROJECT_ID>'` retrieves the secret. Keep its output private. [Spectrum SDK](https://github.com/photon-hq/spectrum-ts) · [Legacy CLI](https://photon.codes/docs/legacy/cli/installation)

Continue with the [Grok Bot tutorial](grok-bot.md#3-connect-photon-and-text-the-relay) or the [LangChain + Ollama tutorial](langchain-ollama.md#3-text-your-agent).
