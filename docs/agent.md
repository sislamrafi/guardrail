# Console agent

The **Agent** section (the sparkle icon below MCP docs) is a chat that can run the whole console:
groups and keys, context files and MCP docs, guard layers, rules, servers and models, settings, and
the console's own look. It uses a chat model from one of your own servers.

- **Left:** your chats, newest first, grouped by day, with search (titles and messages). Use **New
  chat** to start one. Double-click a chat to rename it.
- **Middle:** the chat. Replies stream in. Each tool the agent uses shows as a small card (click it
  for the arguments and result), and interactive components appear inline. **Enter** sends;
  **Shift+Enter** adds a new line.
- **Right:** the change log for this chat, one row per turn. Click a row to see each change: the
  table, the row, field by field before → after. Each change has **Revert**.

## Picking a model

Click the model button in the chat header. A dialog lists every chat model on your servers, with
type, context size and price, and a search box. The choice is remembered in this browser and saved
with the chat. The model must support OpenAI-style tool calling.

## What it can do

| Area | Tools |
| --- | --- |
| Read | overview, groups (and what each resolves to), keys, servers and models with types and prices, price analytics (with a chart), context files, MCP docs, guard layers, rules, activity, settings |
| Groups | create, rename, move, delete (asks first), set any inherited setting |
| API keys | create (the secret is shown to you only), edit, caller line, MCP access, IP list, revoke and rotate (ask first), delete (asks first), reveal a secret (to you only) |
| Context files / MCP docs | create, edit (whole text or find → replace; every edit is a new version), delete (asks first), give to a group or key, take back, switch an inherited one off or on |
| Guard layers | add, edit, reorder, remove (asks first), switch on or off per group or key |
| Rules | create, edit, delete (asks first) |
| Servers and models | add a server (its API key goes through a secure field), rediscover, switch models on or off, set a model's type, remove a server (asks first) |
| Settings and console | global settings; the console theme and preferences; open any page |
| Components | tables, charts, choices and short forms in the chat (`show_ui`) |

## Safety

- **Secrets never pass through the model.** Adding a server shows a secure API key field in the chat.
  What you type goes straight to the server, encrypted, and the agent only learns "saved". Key
  secrets appear behind a **Reveal** button for you. Tool results carry no secrets (only "key
  saved: yes"). Tests check that no secret ends up in the chat or the change log.
- **Destructive actions wait for you.** Delete, revoke, rotate and removing a server show a
  **Confirm** card. Nothing changes until you press it.
- **Same rules as the console.** The tools call the same admin API handlers, with the same checks,
  as your own clicks. The agent runs only while you are signed in.

## Change log and undo

Before a tool that writes runs, the tables it may touch are snapshotted (secret columns left out).
Afterwards they are compared, and every row that changed is logged with its before and after state.

- **Undo to here.** Hover your message and click the history icon. A preview lists everything the
  agent changed from that message on. Confirming puts it back, newest first, and marks those
  messages *undone*, so the agent forgets them.
- **Revert one change** from the change log.
- **Files and docs keep their history.** Reverting a context file or MCP doc saves the old text as a
  new version.
- **Conflicts.** If someone changed a row after the agent did, the preview marks it *changed
  since*. It is skipped unless you tick **overwrite**.
- **Console changes** (theme, preferences) are undone in the browser.
- **Can't be undone:** a deleted API key (its secret is gone; create a new one) and a rotated
  secret.

## Live updates

Every change, by the agent, by you, or in another tab, is announced over `/api/admin/events`. Every
open view refreshes on its own: trees, panels, badges and pages. An editor with unsaved text is not
overwritten; it says the file changed elsewhere.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/agent/chats?q=` | Chats, newest first; `q` searches titles and messages |
| POST | `/api/admin/agent/chats` | `{model, serverId}` |
| GET / PATCH / DELETE | `/api/admin/agent/chats/:id` | Chat with messages and changes; rename or change model; delete (the change log stays) |
| POST | `/api/admin/agent/chats/:id/send` | `{text}` → server-sent events: `turn`, `token`, `assistant`, `tool`, `ui`, `changes`, `title`, `error`, `done` |
| POST | `/api/admin/agent/chats/:id/confirm` | `{pending, approve}` → the same event stream |
| GET | `/api/admin/agent/chats/:id/undo?turn=&only=` | What undo would revert, with conflicts |
| POST | `/api/admin/agent/chats/:id/undo` | `{turn, force?, only?}` |
| GET | `/api/admin/events` | Server-sent events, one per change |

## Testing without a real model

`scripts/mock-vllm.mjs` answers a message like `[tool:create_group {"name":"QA"}]` with that tool
call, then "Done: …" with the result. `tests/agent.test.ts` uses it to check tools, the change log,
undo, conflicts, confirmation and that secrets never reach the model.
