# Guard layers and decision models

Every request that passes authentication goes through an ordered list of **guard layers** before
GuardRail adds context and calls the model:

```
After authentication (key, IP, schema, model access, rate limit, custom rules)   ← fixed
  1. layer
  2. layer
  …
Add context, call the model                                                      ← fixed
```

Layers are edited on the **Guard checks** page. Each group can switch any layer on or off for
itself and its sub-groups ("same as parent / on / off"), like every other group setting.

## A layer

| Field | Meaning |
| --- | --- |
| Type | `classifier` (a scoring model), `judge` (an LLM with a system prompt), `patterns` (built-in injection patterns, no model), `redactor` (built-in secrets and PII redactor, no model). |
| Model, server | Any model on any server, on or off for clients. Decision and text models are listed first. |
| Adapter | How to read the model's answer (below). `auto` picks one from the model name. |
| Prompt, block when, allow when | The judge's system prompt and optional extra guidance. Groups can append lines. |
| Threshold, attack class index | For scoring models: a score at or above the threshold is a hit. |
| Runs on | `all`: every request. `flagged`: only when an earlier layer flagged it, or every request when no earlier layer screened it. |
| When it says no | `block` stops the request with the blocked reply. `flag` passes it on as flagged to later layers. `redact` replaces the matches with `[REDACTED]` and continues. |
| If it fails | `allow`, `block`, or (for scoring layers) fall back to the built-in patterns. |
| Time limit | Per call. |

A request still flagged when the pipeline ends is decided by **Flag nobody cleared** (block or allow).
A flag that a later layer clears is logged as a **false alarm**.

The old two checks are migrated into two layers so behaviour does not change: **PIGuard**
(`classifier`, every request, *flag*, fall back to patterns) followed by **OSS judge** (`judge`,
only flagged requests, *block*, fallback = the old "if it fails or times out" setting).

## The decision contract

Whatever the model, every layer produces one shape, and the pipeline only ever sees this:

```ts
{
  verdict: 'allow' | 'block' | 'flag',
  score: number | null,      // 0..1 when the model gives one
  categories: string[],      // e.g. "S1 Violent crimes", "violence", "AWS access key"
  reason: string,
  raw: string,               // the model's answer, shown in the tester and the log
  latency_ms: number,
  error?: string             // set when the call failed or the answer could not be read
}
```

Adapters never throw. A timeout, an HTTP error or an unreadable answer comes back with `error` set,
the layer's fallback decides, and the log shows "Check N · name failed".

## Adapters

| Adapter | Models | Request | How the answer is read |
| --- | --- | --- | --- |
| `classifier` | PIGuard, Prompt-Guard, DeBERTa injection classifiers | `POST /classify` (then `/pooling`) with text windows | Probability at the attack class index (or an injection-like label); the highest window wins. Hit when ≥ threshold. |
| `llama_guard` | Llama Guard 3 / 4 | Chat completion, content as the user turn | `safe`, or `unsafe` followed by codes like `S1,S14`, mapped to the MLCommons hazard names. |
| `yes_no` | ShieldGemma, Granite Guardian | Chat completion with the layer prompt, asking for logprobs | "Yes" means a violation. With logprobs, P(Yes) is the score compared with the threshold. |
| `moderation` | OpenAI-compatible moderation models | `POST /v1/moderations` | `flagged`, `categories`, and the highest `category_scores` value. |
| `json_judge` | Any chat model with a system prompt (gpt-oss-safeguard, Qwen, …) | Chat completion, JSON mode when the server supports it (retried without on 400) | `{"verdict","score","reason","categories"}`; tolerates prose around the JSON and the older `decision` key. |
| `text` | Anything else | Chat completion | Looks for allow / block / safe / unsafe. |

Auto-detection from the model name: `llama-guard` → `llama_guard`; `shieldgemma`, `granite-guardian`
→ `yes_no`; `moderation` → `moderation`; `piguard`, `prompt-guard`, `deberta`, `injection`,
`classif` → `classifier`; otherwise judges use `json_judge` and classifier layers use `classifier`.

## Finding decision models

Discovery reads `/v1/models` and, optionally, a few extra listings some providers keep apart
(`/v1/models?output_modalities=all`, `/v1/embeddings/models`, `/v1/moderations/models`), merged by id.
A listing that fails is skipped and noted ("some listings unavailable"); discovery only fails when
nothing answers. Models are typed (Text, Image, Audio, Video, Embedding, Rerank, Decision/classifier,
Other) from OpenRouter's architecture, a vLLM task field or the name, and the type can be overridden.
When a listing still misses a model, add it on the server page with **Add a model by id**; it is
marked "added by hand" and kept on rediscovery.
