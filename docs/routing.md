# Routing

A **router** layer chooses which model answers a request. It asks a decision model a question,
for example "is this request simple or complex?", and maps each answer to a model.

Use it to send short questions and small edits to a fast, cheap model, and keep the large model
for multi-file work, design and debugging.

## Setting one up

1. On **Guard checks**, add a layer of type **Router**.
2. Pick a decision model, for example `typesafe/jev-1.14` on an OpenRouter server.
3. The question starts from the routing preset:

   ```
   Question:  choice
   Instructions: How hard is this request for a coding model? {policy}
   Criteria:
     simple = A small, well-defined change, a question or a lookup.
     complex = Multi-file work, design, debugging or anything needing careful reasoning.
   ```

   You can add labels (for example `docs`, `tests`) or switch to a **score** question with levels.
4. Under **Routes**, map each label to a model: `simple → qwen3-coder-30b`,
   `complex → anthropic/claude-sonnet-5`.
5. Set a **fallback model**. It is used when the answer has no route or the decision fails. Leave it
   empty to keep the model the client asked for.

## Rules

- A route only takes effect if the key may use the target model, through its group's models list
  or its own exceptions. Otherwise the client's model is kept, and the step says why.
- A router never blocks. Its outcomes pick a model, and only an error is logged as one.
- The router runs where it is placed in the pipeline. Put it after the security layers, so a request
  that will be blocked doesn't cost a routing decision.
- A router changes the model, so suffix layers placed before it can't share the cache with the
  final call. The layer editor warns about this.
- Groups can switch the router on or off and add lines to its `{policy}`, like any other layer.

## In Activity

The Summary shows *Model router: chose "simple" (confidence 0.91) → qwen3-coder-30b*. The model
column shows the routed model. The original model stays in the request body on the Session tab.

## Decision questions

Router and guard layers share one question format, through the
[OpenRouter Decisions API](https://openrouter.ai/docs):

| Type | Answer | Use |
| --- | --- | --- |
| `noul` (yes/no) | probability of "true" | injection: yes/no |
| `choice` | a label, with probabilities | routing; safe / unsafe; approve / deny / ask |
| `score` | a level on a scale | risk 0–4 |

Questions can be saved on the **Schemas** page and reused by several layers.
