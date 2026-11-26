# Changelog

## [0.1.0]

First release on npm.

- Eden AI as a Pi provider, its models read live from `/v3/models` (`/edenai-sync` refreshes them).
- Each model listed once by the name provider routing takes; `provider/model` ids pin a provider.
- Each model's own `max_output_tokens` from the catalog.
- Pi's session id sent as `x-session-id`, so Eden AI Monitoring and Trace Export group a Pi session.
- EU endpoint and EU-only catalog (`EDENAI_BASE_URL`, `EDENAI_EU_ONLY`).
- The key read from `EDENAI_API_KEY` or `EDEN_AI_API_KEY`.
