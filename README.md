# pi-edenai

**Eden AI provider for [Pi](https://github.com/earendil-works/pi).** One extension gives Pi access to **700+ models** from every major provider — OpenAI, Anthropic, Google, Mistral, DeepSeek, Cohere, Amazon, xAI and more — through a single [Eden AI](https://www.edenai.co/) key and one OpenAI-compatible, **EU-hosted** endpoint.

- **One key, every model.** Each model is listed once by the name Eden AI routes (`claude-sonnet-4-5`, `gpt-4o`, `~claude-fable-latest`, …), and provider routing picks the provider for each call. To pin a provider, pass its `provider/model` id with `--model` (`anthropic/claude-sonnet-4-5`).
- **Live model discovery.** The catalog is fetched from Eden AI's `/v3/models` at startup, so pricing, context window, vision and reasoning support always match what's live on your account. Refresh any time with `/edenai-sync`.
- **EU data residency.** Point at the EU endpoint and optionally restrict to EU-eligible models for GDPR-sensitive work.

## Install

```bash
# npm
pi install npm:pi-edenai

# or git
pi install git:github.com/edenai/pi-edenai
```

Or drop it into an auto-discovered location:

```text
~/.pi/agent/extensions/pi-edenai/   (global)
.pi/extensions/pi-edenai/           (project-local)
```

Or reference it from `settings.json`:

```json
{
  "packages": ["npm:pi-edenai"]
}
```

## Setup

Grab a key at [app.edenai.run](https://app.edenai.run) and export it:

```bash
export EDENAI_API_KEY="your-eden-ai-key"
```

Then start Pi — "Eden AI" appears as a provider and its models show up in the picker and in `pi --list-models`.

```bash
pi
```

Quick test without installing:

```bash
pi -e ./index.ts
```

## EU data residency (GDPR)

```bash
# route through the EU endpoint
export EDENAI_BASE_URL="https://api.eu.edenai.run/v3"

# and, optionally, only register EU-eligible models
export EDENAI_EU_ONLY="1"
```

## Commands

| Command | Description |
|---------|-------------|
| `/edenai-sync` | Refresh the model catalog from the live Eden AI API (no restart needed). |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `EDENAI_API_KEY` | — | Your Eden AI API key (required). |
| `EDENAI_BASE_URL` | `https://api.edenai.run/v3` | Override the endpoint (e.g. the EU endpoint). |
| `EDENAI_EU_ONLY` | unset | When set, use the EU endpoint by default and register only EU-region models. |
| `EDENAI_MAX_TOKENS` | unset | Max output tokens for every model. Unset, each model takes its own `max_output_tokens` from the catalog (the smallest among its providers), else 32,768 for a reasoning model and 8,192 otherwise. |

## How it works

Eden AI speaks the OpenAI Chat Completions protocol, so the extension registers a single provider with `api: "openai-completions"` and lets Pi's built-in OpenAI-compatible path do the rest — no custom streaming code. Models come straight from `GET /v3/models?view=models`, one per model Eden AI routes, mapped to Pi's model config (per-token pricing converted to `$`/million, context window, `text`/`image` input, and reasoning support). If the live catalog can't be reached at startup, a small curated set of current models is registered so the provider still works; `/edenai-sync` then loads the full list.

Every model sends Pi's session id with each call as the `x-session-id` header, so Eden AI's Monitoring, and the tracing tools its Trace Export sends to, group a Pi session's calls under Pi's own id. Pi leaves the header out when prompt caching is off (`cacheRetention: "none"`).

## Develop / test

```bash
npm install
npm test                          # unit tests for the catalog mapping (tsx)
EDENAI_API_KEY=... npm run test:e2e   # live tests against the real Eden AI API
npm run typecheck
```

Live tests live in `tests/e2e/` and read the key from the environment only —
never hardcoded. They skip cleanly when `EDENAI_API_KEY` is unset.

## License

MIT © Eden AI
