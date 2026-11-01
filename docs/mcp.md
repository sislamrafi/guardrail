# MCP docs server

GuardRail serves your team's Markdown docs to coding agents over the
[Model Context Protocol](https://modelcontextprotocol.io). Agents use the **same GuardRail API key**
they already use for `/v1`, and each key sees exactly the docs shared with its group (inherited down
the tree) or with the key itself.

Use it for runbooks, conventions, architecture notes, API guides and onboarding: anything an agent
should *look up when relevant* rather than carry in every prompt.

![MCP docs](screenshots/mcp-docs.png)

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

- **Groups.** Drag a doc onto a group in the explorer, or tick the group in the doc's **Who can see
  this** panel. Sub-groups inherit it. A group can also *replace* its parent's list with its own
  (`override`), for example to give contractors no docs.
- **Keys.** Tick a key in **Who can see this** to give that key a doc on top of its group's. This is
  stored as the key's own exception (`mcp_docs`, mode `add`).
- **MCP access.** Each key has an **MCP access** switch on its page (on by default). With it off,
  `/mcp` refuses the key with a 403.

The **What each key sees** table on the MCP docs page shows each key's effective list. **Test as a
key** runs `list_docs`, `search_docs`, `read_doc` or `resources/list` as any key and shows exactly
what its agent would get.

## The explorer and the MCP access panel

The MCP docs explorer shows the group tree with each group's own docs **and its API keys**. Keys
with MCP access off, or revoked, are dimmed. Selecting a group or a key opens the right sidebar
(**MCP access**) for it:

- every doc it can read, marked **Own** (shared with this group), **This key** (shared with this
  key only) or **Inherited · <group>** (change it on that group);
- quick actions: share a doc with the group or key, or stop sharing an own doc;
- for a key: its MCP access switch and **Test as this key**;
- for a group: its keys, with how many docs each one sees.

Clicking a doc opens it in the editor. Clicking a key opens its MCP view in the middle: the docs it
can read and why, a **Test as a key** runner, and its recent MCP calls from Activity, with a link to
the full key page.

## Editing

Docs are Markdown with a title, slug, description and tags. The editor autosaves 5 seconds after
you stop typing, keeps a version history (restore any version into the editor), and has a rendered
preview. Upload `.md` files from the explorer: each becomes a doc, shared with the selected group.

The **description** is what agents read to decide whether to open a doc, so write it for them:
"How we ship to production, step by step, and how to roll back".

![Doc editor](screenshots/mcp-doc-editor.png)

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

## Custom tools (later)

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
