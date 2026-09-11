# DeepSearchQA Skill Eval Template

A template repository for evaluating chat models on `google/deepsearchqa` using a Pi agent, You.com MCP tools (`you-search`, `you-contents`), and a research Skill. Create a repo from this template, set `MODEL`, and run the full pipeline locally.

The pipeline is:

```text
DeepSearchQA dataset
        │
        ▼
scaffold ──► prompts.jsonl ──► generate ──► trajectories.jsonl
                                                │
                                                ▼
                                      grade ──► graded.jsonl + summary.json
                                                │
                                                ▼
                                      export/upload ──► results artifacts
```

## Quick start

Install Bun and uv, then configure credentials:

```sh
bun install
export OPENROUTER_API_KEY=...
export YDC_API_KEY=...
```

Run a one-question smoke (a score of `0` can still be a valid smoke result if the model missed the answer — check that `process.totalToolCalls` is greater than `0`):

```sh
MODEL=<org>/<model> FORCE=1 LIMIT=1 K=1 CONCURRENCY=1 bun run eval
cat data/summary.json
```

Full run:

```sh
MODEL=<org>/<model> caffeinate -dimsu bun run eval
bun run export-results
huggingface-cli login
bun run upload
```

`MODEL` (an OpenRouter model id, e.g. `minimax/minimax-m3`) is required by `generate`, `grade`, and the adapter. The dataset is fixed to `google/deepsearchqa`; `DATASET`, `HF_CONFIG`, and `HF_SPLIT` are overridable in `scripts/scaffold.ts` if you adapt the template to another dataset.

## Commands

```sh
bun run scaffold       # DeepSearchQA -> data/prompts.jsonl
bun run generate       # prompts.jsonl -> trajectories.jsonl
bun run grade          # trajectories.jsonl -> graded.jsonl + summary.json
bun run eval           # scaffold + generate + grade
bun run export-results # graded.jsonl -> results.jsonl
bun run download       # download published artifacts from HF into data/
bun run upload         # upload README.md and data/* to HF
bun run query          # query large JSONL artifacts with clickhouse-local
bun run analysis       # tool/skill usage analysis over data/*.jsonl
bun run check          # typecheck + tests
```

## Results

### Full run — 2026-09-11

| | |
| --- | --- |
| Model | `meta/muse-glimmer-30b` (OpenRouter) |
| Thinking level | `medium` |
| Trials / tasks | 2700 trials / 900 tasks (K=3) |
| Average answer F1 (raw) | **0.4262** |
| Average answer F1 (adjusted, 2688 gradable trials) | 0.4281 |
| Trial pass rate (score >= 0.8) | 37.0% |
| `exactPassAtK` (task-level, any trial >= 0.8) | **53.22%** |
| Ungradable trials | 12 |

Cost and process (from `data/summary.json`):

| Metric | Value |
| --- | --- |
| Model cost | $88.33 |
| You.com API cost | $110.12 |
| Total cost | $198.45 |
| Avg total cost / trial | $0.0735 |
| Input tokens | 217.8M |
| Output tokens | 7.4M |
| Avg tool-call events / trial | 18.05 (incl. started+completed events per call) |
| Failed tool-call events (budget-cap blocks) | 2463 |
| Error events | 0 |
| Avg end-to-end latency / trial | 88.5s |
| Trial statuses | 1695 completed / 1005 failed |

Interpretation (observations for this run of this model, not cross-model conclusions): the extension-enforced 10-call budget held — trials averaged well under the skill ceiling in real calls, with blocked-call retries (`failed` tool-call events) averaging under one per trial, and zero error events across all 2700 trials. Within-budget trials scored slightly better (avg F1 0.44 vs. run average 0.43), and 479/900 tasks produced a fully-correct trial at K=3. The 1005 `failed`-status trials (37%) scored 0 and represent adapter/harness failures (mostly earlier generate runs before the grading-flow fixes), depressing the raw average.

For reference, the DeepSearchQA paper's Table 4 reports GPT-5 High Reasoning at 73.24 F1, Gemini 3 Pro Preview at 76.86 F1, GPT-5 Pro High Reasoning at 78.98 F1, and Gemini Deep Research Agent at 81.90 F1.

## Metrics definitions

`summary.json` reports raw metrics over all rows and adjusted metrics excluding ungradable rows with missing gold answers. `exactPassAtK` is task-level: a task passes if any of its `K` trials scores at least `0.8`.

Cost fields:

- `modelCostUsd` from OpenRouter usage metadata.
- `youApiCostUsd` estimated from You.com pricing, currently `$5/1k` Search calls and `$1/1k` full-page extraction or Contents pages.
- `searchExtractionPages` and `searchExtractionCostUsd` for Search `extraction_mode: "full_page"` pages, counted across web and news results. Highlights-mode search results are included in the per-call Search price and are not billed as extraction pages.
- `totalCostUsd` as model plus You.com API cost.

## Querying large artifacts

The JSONL artifacts in `data/` can be multi-GB. Use the ClickHouse helper instead of loading them into memory:

```sh
bun run query -- --list
bun run query -- summary --dry-run
bun run query -- failures
```

This requires `clickhouse-local` on `PATH` (set `CLICKHOUSE_LOCAL` if your binary lives elsewhere).

## Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `MODEL` | generate, grade | OpenRouter model id (required) |
| `K` | generate, grade | Trials per task (default `3`) |
| `CONCURRENCY` | generate, grade | Parallel trials (default `24`) |
| `GRADE_CONCURRENCY` | grade | Parallel grading trials (overrides `CONCURRENCY`) |
| `THINKING_LEVEL` | generate | `off`..`xhigh` (default `medium`) |
| `LABEL` | generate | Run label (defaults to `<model>-you-web`) |
| `JUDGE_MODEL` | grade | LLM judge id (default `deepseek/deepseek-v4-flash-0731`; keep fixed across runs for comparability) |
| `JUDGE_FALLBACK_MODEL` | grade | Judge used if the primary judge call fails (default `qwen/qwen3.6-flash`) |
| `JUDGE_TIMEOUT_MS` | grade | Per-judge-call timeout (default `180000`) |
| `FORCE=1` | generate, grade | Discard prior artifacts for a clean rerun |
| `HF_DATASET_REPO` | upload, download | Target HF dataset repo |
| `OPENROUTER_API_KEY` | generate | Model access |
| `YDC_API_KEY` | generate | You.com API access |

## Publishing to Hugging Face

Set `HF_DATASET_REPO=<namespace>/<repo>` (the uploader defaults to a placeholder repo and will fail until you set it). The uploader runs through `uv` with the official `huggingface_hub` client, prepends dataset-card metadata to `README.md`, and can update only the card with:

```sh
bun run upload -- --card-only
```

Upload a subset of artifacts with `--files` (comma-separated remote names):

```sh
bun run upload -- --files results.jsonl,summary.json,README.md
```

## Skill

The adapter loads the research Skill from `skills/you-web/SKILL.md`. It encodes a focused workflow for the `you-search` and `you-contents` MCP tools. Tune it per model as needed; keep authentication in local environment or local MCP configuration, and do not commit API keys, customer data, or private evaluation cases.

## Tool budget enforcement

The Skill text asks the model to stay within ~10 tool calls, but smaller or less instruction-following models ignore that ceiling and tail-chase (one trial ran 17+ `you-search` calls without converging to an answer). To make the budget binding for such models, `src/extension.ts` registers a `tool_call` hook that hard-caps total tool calls at 10 per trial: calls past the cap are blocked with a `Tool budget exhausted … write your final answer now` reason, which gives the model one more LLM turn to emit its answer instead of looping.

Because the cap blocks calls (returning `status: 'failed'` in the trajectory), the harness's default `failOnFailedToolCalls` would penalize the cap's own blocked calls as process failures. `scripts/grade.ts` sets `failOnFailedToolCalls: false` on the `process` rubric so the cap's blocked calls are not counted against the process score; the budget is enforced at runtime by the extension, and the process rubric scores the run honestly (completed status, no error events) rather than re-litigating the cap. Stronger models that stay within the budget never trigger a block and are unaffected.

## License

MIT.
