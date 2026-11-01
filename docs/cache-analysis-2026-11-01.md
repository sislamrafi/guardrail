# Prompt-cache analysis, 1 Nov 2026

Is the "cache-friendly" (suffix) setup actually saving anything on the traffic sent so far?
Data: the local GuardRail database and saved prompt files, read with non-secret columns only (no
keys, no server credentials, no `.env`).

## Traffic

There is no real client traffic yet: every logged request is Studio test traffic.

| Source | Requests | Group | Model |
| --- | --- | --- | --- |
| Key `laptop-2` (Studio, acting as the key) | 14 | Org › dev › erp › fronetned | `z-ai/glm-5.3-flash` |
| Studio as group `admin` | 5 | Org › admin | `deepseek/deepseek-v4.1-flash` |
| Studio as group `Org` (my tests) | 10 | Org | `deepseek/deepseek-v4.1-flash` |

Studio requests go through the same gateway path as a real client, so they're representative.
The analysis below is about `laptop-2`, the only key with guard layers on (`dev` turns all three
on; `Org` turns them off).

## Configuration

| Layer | When | Model | Format | Placement | Use request's model | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Security Check | before | `typesafe/jev-1.13` | Decisions API | prefix | – | decision model: cheap, no chat prefix to cache |
| LLM Reason | before, only if flagged | (request's model) | JSON judge | **suffix** | yes | runs only when Security Check flags |
| Answer check 3 | after the model | (request's model) | JSON judge | **suffix** | yes | retry ×2, then block; 5 s time limit |

Context: `contextPlacement: top`, no policy prompt, one context file per group in the chain.
Nothing in the injected context changes per request (no timestamps or ids).

**Config verdict:** the setup is right for caching. Both suffix layers use the request's own model
and server, there's no redactor or router before them, and context goes at the top. One problem:
**Answer check 3 has a 5 s time limit.** A suffix check reads the whole conversation, and on
`req_3cf9a839` (2,155 tokens) answer #1's check **timed out at 5,000 ms**. That fell back to
"block", which caused a needless retry and a 19.5 s request.

## Is the prefix stable turn to turn?

Yes. Within the `laptop-2` conversation, each turn's upstream messages start with the whole
previous turn's messages, byte for byte:

```
req_3bb62e74  4 msgs (first)
req_17e0d28b  6 msgs  shares 4/4
req_d30f4a85  2 msgs  shares 0/6   ← new chat (system prompt changed: 578 → 642 chars, a context file was edited)
req_10a5ca09  4 msgs  shares 2/2
req_dacee196  4 msgs  shares 4/4
req_608c30d7  6 msgs  shares 4/4
req_27f64888 10 msgs  shares 6/6
req_376eefb8 12 msgs  shares 10/10
req_1e3d7870 18 msgs  shares 12/12
req_3cf9a839 20 msgs  shares 18/18
```

The suffix checks send the same messages and tools as the model call (built by the same function)
and only add one message at the end. So **the structure is cache-friendly.**

## Measured cache use

Main model calls (`laptop-2`, where the reply was stored):

| Request | Prompt tokens | Cached |
| --- | ---: | ---: |
| req_608c30d7 | 477 | 0 |
| req_27f64888 | 689 | 0 |
| req_376eefb8 | 856 | 0 |
| req_1e3d7870 | 1,049 | 0 |
| req_3cf9a839 | 2,155 | 0 |
| **Total** | **5,226** | **0 (0%)** |

Suffix guard checks:

| Request | Check | Prompt tokens | Cached | Provider | Time |
| --- | --- | ---: | ---: | --- | ---: |
| req_7f4e9a79 | LLM Reason | 1,111 | 0 | Reka | 1,419 ms |
| req_3cf9a839 | Answer check, answer #2 | 2,214 | 0 | Reka | 1,738 ms |
| req_3cf9a839 | Answer check, answer #3 | 2,680 | **1,280** | Reka | 2,332 ms |
| **Total** | | **6,005** | **1,280 (21%)** | | |

On DeepSeek with a 2,500-token conversation (my test on 31 Oct), after one warm-up request the
checks read **92%** and model calls **96%** of their prompt from the cache.

Latency: Security Check (jev, decisions) 517–1,647 ms; suffix checks 1.4–3.7 s; model calls
2.3–3.5 s (15.8 s for one long answer).

Money: `glm-5.3-flash` input costs about $0.015 per 1M tokens, so the 1,280 cached tokens saved well
under $0.0001. Even a 90% hit rate saves little on a model this cheap. The win is mostly
**latency** (cached prefixes are read much faster) and it grows with longer Cline sessions.

## Why the hits are low here

1. **Short prompts.** 3 of the 5 model calls were under ~1,024 tokens, the minimum most providers
   cache. Nothing GuardRail can change; real Cline sessions (system prompt, tools and file contents,
   usually 10k+ tokens) are well above it.
2. **The provider memory was being reset.** OpenRouter runs `glm-5.3-flash` on several providers,
   each with its own cache. GuardRail asks for the provider that answered last, but it kept that in
   memory that a dev-server code reload wiped (and I reloaded it often today). So most model calls
   went to whichever provider OpenRouter picked, cold. **Fixed:** the memory now survives reloads.
3. **Retries didn't follow the warm provider.** After a rejected answer, the next model call could
   go to a different provider than the one that just served the conversation. **Fixed:** retries now
   ask for the provider that answered.
4. **The model call's provider wasn't recorded**, so you couldn't check that the check and the call
   shared a cache. **Fixed:** it's stored with the reply and shown in Activity › Summary next to the
   model call's cache line.
5. **5 s time limit on a suffix check** (see Configuration). **Your setting**, so I didn't change it.
   The layer editor now warns about it when Suffix is on. Raise it to 15–30 s, or set "If it fails" to
   Allow for an answer check.

## Verdict

- The request structure is cache-friendly and stays stable turn to turn. Suffix checks share the
  exact prefix of the model call.
- On this traffic it **has not saved anything meaningful yet**: 0% on model calls, 21% on suffix
  checks. That's mainly because of short test prompts and the provider memory resets above (now
  fixed).
- On a realistic, longer conversation the same setup reached 92–96% cached prefixes after the
  first request.
- Next: send a few longer Cline turns through `laptop-2` after reloading the app, then check
  Activity › Summary. The model call and each suffix check show "N of M prompt tokens from cache ·
  provider X", and the Answer check layer editor shows the measured hit rate.
