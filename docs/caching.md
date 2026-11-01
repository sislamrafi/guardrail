# Prompt caching

Coding agents send long, growing conversations: a large system prompt, tool definitions, file
contents, and every earlier turn. Providers can cache a prompt prefix they have already seen, which
makes it much cheaper and faster to read. GuardRail is built so that its own additions, and its
checks, keep that prefix stable.

## What GuardRail keeps stable

- **Context goes at the top.** The caller line, the policy prompt and the context files are placed
  at the top of the first system message, in a fixed order. Nothing in them changes per request (no
  timestamps, no request ids). The caller line (`Request from: mina (API key: mina-vscode)`) is
  constant per key.
- **One serializer.** The message list the model gets is built by one function
  (`forwardMessages` in `src/lib/gateway.ts`). Suffix checks use the same function, so their
  prefix is byte-for-byte identical to the real call.
- **Cache breakpoints.** Anthropic and Gemini models only cache from explicit breakpoints. GuardRail
  marks the end of the shared part (`cache_control`) for those models.

## Prefix vs suffix checks

| | Prefix (default) | Suffix |
| --- | --- | --- |
| Sends | the layer prompt, then the text to check | the full request as the model will get it, then the question |
| Prompt size | small | the whole conversation |
| Cache | its own (small) | shared with the model call |
| Sees | only the new content | everything, including tools and earlier turns |
| Best for | classifiers, decision models, cheap judges | judges that need context; after-the-model checks |

Turn on **Use the request's model** for a suffix layer, so the check runs on the same model and
server as the real call. A different model never shares the cache.

The layer editor shows a warning when caching is unlikely, for example when:

- the layer checks with its own model instead of the request's;
- the server is a hosted API, where caching is up to the provider;
- a layer before it can redact text, or a router can switch the model;
- the conversation is short (providers cache only above a minimum size, often 1,024 tokens);
- the time limit is under 10 s for a check that reads the whole conversation.

It also shows the layer's measured hit rate (`GET /api/admin/guard/cache/:id`).

## OpenRouter: sticky providers

OpenRouter serves many models on several providers, each with its own cache. GuardRail remembers
the provider that last served each model, and asks for it (`provider.order`) on suffix checks and
on the model call after a suffix check. After-the-model retries are pinned to the provider that
just answered. The memory survives dev-server reloads.

The provider that served each call is stored with it and shown in **Activity › Summary**, next to
the cache line ("1,280 of 2,680 prompt tokens from cache · provider X").

## Measured

On a 2,500-token conversation through OpenRouter, after one warm-up request: suffix checks read
**92%** of their prompt from cache, and the model call **96%**.

Short prompts (under about 1,024 tokens) aren't cached by most providers at all. Real agent
sessions are usually well above that. For a worked example on real traffic, see
[cache-analysis-2026-11-01.md](cache-analysis-2026-11-01.md).

![Suffix layer and cache warning](screenshots/guard-suffix-layer.png)
