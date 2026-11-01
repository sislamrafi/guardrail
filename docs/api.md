# HTTP API

## Gateway (for agents)

All gateway routes need `Authorization: Bearer grk_live_…` (or `x-api-key`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/models` | Models this key may use. |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions. Supports streaming. |
| `POST` | `/v1/completions` | Legacy completions. Supports streaming. |
| `POST` | `/mcp` | MCP docs server (JSON-RPC, Streamable HTTP). See [mcp.md](mcp.md). |

Errors use OpenAI's shape, `{"error": {"message", "type", "code", "param"}}`:

| Status | When |
| --- | --- |
| 400 | The body is not valid JSON. |
| 401 | The key is missing, invalid, revoked or expired. |
| 403 | The request comes from an IP address the key is not bound to. |
| 403 | The model is not allowed for this key (not in its groups, not enabled on any server, or a limit excludes the group). |
| 422 | Schema mismatch under the strict policy. |
| 429 | Rate limit reached. |
| 502 | Every server for the model failed. |

A request stopped by the guard or a custom rule is **not** an error. It returns 200 with an assistant message (see [architecture.md](architecture.md) and [after-model-checks.md](after-model-checks.md)). Every response carries an `x-guardrail-request-id` header that matches the Activity log, and blocked replies also carry `x-guardrail-blocked: 1`.

## Admin API

Everything is under `/api/admin/` and returns JSON. Failures come back as `{"error": "…"}` with a 4xx status. When an admin password is set, these routes need the session cookie from `POST /api/auth/login` with body `{"password"}`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `servers` | Servers with models, health, prefix-cache rate, limits and access map. Server keys are never returned, only whether one is saved |
| POST | `servers/discover` | `{url, apiKey?}` → models found at the server, with type, price and context where the server reports them |
| POST | `servers` | `{name, url, apiKey?, role, models, enabled}` |
| PATCH / DELETE | `servers/:id` | Edit or remove a server |
| POST | `servers/:id/models` | Add a model by ID (for models discovery misses) |
| POST | `servers/:id/rediscover` | Re-read the model list (new models arrive hidden) |
| PATCH | `models/:id` | `{enabled}`, type override |
| POST / DELETE | `limits`, `limits/:id` | Global, server or model limits |
| GET / POST | `groups` | Tree with resolved settings, or `{name, parentId, description}` to create a group |
| GET / PATCH / DELETE | `groups/:id` | Read (with the resolution matrix), rename or move, delete |
| PUT | `groups/:id/settings` | `{key, setting: {mode, value}}`, or `{key, setting: null}` to inherit. Keys: `servers`, `models`, `context`, `layers`, `layer_opts`, `blocked_reply`, `rate_limit`, `mcp_docs` |
| GET / POST | `keys` | List keys, or create one (the response includes the secret) |
| POST | `keys/preview` | Effective settings for `{groupId, exceptions}` before creating a key |
| GET / PATCH / DELETE | `keys/:id` | Read, edit (group, exceptions, IP list, caller line, `mcp` access, expiry, revoke), delete |
| GET | `keys/:id/secret` | Reveal the stored secret |
| POST | `keys/:id/rotate` | Issue a new secret. The old one stops working |
| GET / POST | `context` | List files, or create one from `{name, body}` |
| GET / PATCH / DELETE | `context/:id` | Read with history, save a new version, delete |
| GET / PATCH | `settings` | Global settings, including the guard layer list |
| GET | `guard/stats` | 24-hour counts |
| POST | `guard/detect` | `{serverId, model}` → which adapter the model speaks (one probe call, none for Decisions-API models) |
| GET | `guard/cache/:id` | Measured prompt-cache rate of a layer's recent checks |
| POST | `guard/test` | Run the layers on `{text, source, groupId}` without logging |
| POST | `guard/test-live` | The same as an SSE stream: `layer` events, then `result` |
| GET | `overview?range=1h\|24h\|7d\|30d` | Dashboard numbers |
| GET | `logs?filter=&q=&limit=&before=` | Activity rows |
| GET / PATCH | `logs/:id` | One request with prompt, forwarded body, decisions and reply; or `{feedback}` to set a label |
| POST | `logs/:id/replay` | Send the logged request through the gateway again |
| GET | `logs-export?from=&to=&labels=&filter=&format=json` | Download as JSONL (default) or JSON: key, owner, group, IP, model, outcome, label, layers, injected context, prompt, body sent to the model |
| GET / POST / PATCH / DELETE | `rules`, `rules/:id` | Custom rules |
| GET | `studio` | Keys, groups and schemas for Studio |
| GET / POST / PATCH / DELETE | `studio/scenarios`, `studio/scenarios/:id` | Saved scenarios |
| POST | `studio/plan` | What will apply to a scenario (Planned view) |
| POST | `studio/live` | Send through the gateway as an SSE stream: `step`, `layer`, `model`, `draft`, `token`, then `result` |
| POST | `studio/send` | The same, as one JSON response |
| GET | `schemas` | Known schemas and the current policy |
| POST | `schemas/detect` | `{body, path, headers?}` → detection scores |
| GET / POST | `docs` | MCP docs (with who they're shared with and how many keys read them), each key's effective docs and the tool list; or create a doc `{title, slug?, description?, tags?, body?}` |
| GET / PATCH / DELETE | `docs/:id` | Read with history, save (`{title, slug, description, tags, body, autosave?}`), or delete (also removed from every group and key) |
| POST | `docs/test` | `{keyId or groupId, method, params}` runs one MCP call as that key, without logging |
| GET | `summary` | Sidebar counts |
