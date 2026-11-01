# MCP docs server

GuardRail serves your team's Markdown docs to coding agents over the
[Model Context Protocol](https://modelcontextprotocol.io). Agents use the **same GuardRail API key**
they already use for `/v1`, and each key sees exactly the docs shared with its group (inherited down
the tree) or with the key itself.

Use it for runbooks, conventions, architecture notes, API guides and onboarding: anything an agent
should *look up when relevant* rather than carry in every prompt.

![MCP docs](screenshots/mcp-docs.jpg)

## MCP docs vs context files

| | Context files | MCP docs |
| --- | --- | --- |
| How the agent gets it | Added to **every** request, at the top of the system prompt | The agent **asks** for it (list, search, read) |
| Cost | Tokens on every call (cached) | Only when read |
| Good for | Short rules that always apply | Longer reference material, many docs |
| Shared by | Group setting `context` | Group setting `mcp_docs`, plus per-key exceptions |

They are stored separately on purpose (`mcp_docs` and `mcp_doc_versions` tables). A doc library can
grow large, and keeping it apart means it can never end up in prompts by accident. MCP docs also need
fields that context files don't have: a slug for the URI, a description and tags.

## Connect an agent

The endpoint is `http://your-host:3000/mcp` (Streamable HTTP). Authenticate with
`Authorization: Bearer <key>` or `x-api-key: <key>`. The **MCP docs** page shows ready-to-copy
configs for your host. Replace `grk_live_YOUR_KEY_HERE` with the key's secret (**API keys ›
Reveal**).

**Claude Code**

```bash
claude mcp add --transport http guardrail http://your-host:3000/mcp \
  --header "Authorization: Bearer grk_live_YOUR_KEY_HERE"
```

**Cline** (MCP Servers › Configure › `cline_mcp_settings.json`)

```json
{
  "mcpServers": {
    "guardrail": {
      "type": "streamableHttp",
      "url": "http://your-host:3000/mcp",
      "headers": { "Authorization": "Bearer grk_live_YOUR_KEY_HERE" },
      "disabled": false
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in the project)

```json
{
  "mcpServers": {
    "guardrail": {
      "url": "http://your-host:3000/mcp",
      "headers": { "Authorization": "Bearer grk_live_YOUR_KEY_HERE" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "guardrail": {
      "type": "http",
      "url": "http://your-host:3000/mcp",
      "headers": { "Authorization": "Bearer grk_live_YOUR_KEY_HERE" }
    }
  }
}
```

Check it with curl:

```bash
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer grk_live_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_docs","arguments":{}}}'
```

## What agents get

Server name **GuardRail Docs**. The `initialize` result includes instructions that say how many docs
the key has and when to use them.

| Tool | Input | Returns |
| --- | --- | --- |
| `list_docs` | `tag?` | slug, title, description, tags, last update and size of each doc |
| `read_doc` | `slug` | the doc as Markdown |
| `search_docs` | `query`, `limit?` (1–20, default 5) | best matches (BM25 over title, tags, description and body) with a snippet |

All three are read-only (`readOnlyHint`). Tool results include `structuredContent` for clients that
use it.

Resources, for clients that browse them:

- `resources/list`: one resource per doc, `guardrail://docs/<slug>`, `text/markdown`.
- `resources/read`: the doc body.
- `resources/templates/list`: `guardrail://docs/{slug}`.

`prompts/list` returns an empty list.

## Sharing docs

Pick a group or a key in the **Groups & keys** explorer on the left. The right panel (**MCP access**)
has two tabs:

- **Active**: the docs it can read, in order, each with a short tag: *Own* (shared with this
  group), *Key* (this key only), *↳ group* (inherited from that group) or *Off here*.
- **All**: every doc, with search.

Every row has an on/off switch:

- On shares the doc with the picked group (sub-groups inherit it) or with the key only.
- Off on an own doc stops sharing it. Off on an inherited doc **excludes** it here: the group and
  its sub-groups (or just the key) no longer see it. Sub-groups inherit the exclusion and can add
  the doc back.
- **New doc** and **Upload .md** create the doc straight into the picked group or key. You can also
  drag a doc from the list onto any group or key in the tree.

Under the hood this is the `mcp_docs` group setting (`add` / `override`, plus `exclude: [ids]`) and
the key's own `mcp_docs` exception, applied last.

The small footer shows counts (docs readable, own, inherited, off). For a key, it also holds the
**MCP access** switch (on by default; off makes `/mcp` refuse the key with a 403) and **Test as this
key**.

Clicking a key in the explorer, or **Test as this key**, opens the key's MCP view in the middle:

- the docs it reads and why;
- a **Test as a key** runner (`list_docs`, `search_docs`, `read_doc`, `resources/list`, exactly as
  its agent would see them);
- its recent MCP calls from Activity.

The doc editor's **Who can see this** panel does the same from the doc's side.

![MCP docs for a key](screenshots/mcp-key-view.jpg)

## Agentic project management

Because docs are assigned per team and per person, and agents read them on demand, MCP docs work as
a light task and knowledge board for a company's agents:

- **Write runtime docs**: today's tasks, specs, who-does-what, runbooks, conventions. The
  *description* tells agents when to open a doc ("to see what your task is today").
- **Assign them** to a team (group) or a person or agent (key), and switch inherited ones off where
  they don't apply.
- **The agent asks** "what's my task today?" and calls `list_docs` / `search_docs`, then
  `read_doc`. The caller line (`Request from: <owner> (API key: <name>)`) tells the model who it
  works for.
- **Watch it in Activity.** MCP reads and the agent's guarded model calls are logged per key.

Planned: custom tools so agents can write back (update a task's status, add a progress note).

## Editing

Docs are Markdown with a title, slug, description and tags. The editor autosaves 5 seconds after
you stop typing, keeps a version history (restore any version into the editor), and has a rendered
preview. Upload `.md` files from the explorer: each becomes a doc, shared with the selected group.

The **description** is what agents read to decide whether to open a doc, so write it for them:
"How we ship to production, step by step, and how to roll back".

![Doc editor](screenshots/mcp-doc-editor.jpg)

## Security and limits

The same checks as the gateway:

| Check | Response |
| --- | --- |
| Missing, unknown, revoked or expired key | 401, `WWW-Authenticate: Bearer` |
| Request from an address outside the key's IP list | 403 |
| MCP access off for the key | 403 |
| Over the key's rate limit (its group's requests per minute, counted separately from `/v1`) | 429, `Retry-After: 60` |

`/mcp` is exempt from the admin-password middleware, since it authenticates with API keys like
`/v1`. A key can only ever read the docs it resolves to: `read_doc` and `resources/read` for any
other slug answer "not found".

## Protocol notes

- Streamable HTTP, **stateless**. Every message is a `POST` with one JSON-RPC message or a batch,
  answered with `application/json`. Notifications get `202 Accepted` with no body. `GET` and
  `DELETE` return 405, because there are no server-initiated streams or sessions.
- Protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05` are accepted. The
  server answers with the client's version when it knows it.
- Errors use JSON-RPC codes: `-32700` parse error, `-32600` invalid request, `-32601` unknown
  method, `-32602` unknown tool, `-32002` resource not found, `-32001` auth or limit (with the HTTP
  status above).

## Activity

Every MCP call (except `ping` and notifications) is logged in **Activity** under the **MCP** chip.
Each entry records the key, person, group, IP, method and tool (`tools/call:read_doc`), the docs it
touched, the response size, the latency and the client name from `initialize` (for example
`claude-code 2.1`). No model is involved, so no guard layers run.

## Custom tools (planned)

Tools live in a registry (`registerTool` in `src/lib/mcp.ts`). The three doc tools are built-ins.
Custom tools you define in the console will be added to the same registry later.

## Code

| File | What |
| --- | --- |
| `src/app/mcp/route.ts` | The HTTP route |
| `src/lib/mcp.ts` | JSON-RPC dispatch, the tool registry, auth, logging, "Test as a key" |
| `src/lib/mcp-docs.ts` | Doc store, versions, per-key resolution, BM25 search |
| `src/components/console/views/docs.tsx` | The MCP docs page, doc editor, sharing panel, key section |
| `tests/mcp.test.ts` | Protocol, resources, auth, IP binding, rate limit, inheritance, search, logging |
