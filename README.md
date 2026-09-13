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
bun run generate       # prompts.jsonl -> trajectories.jsonl (RETRY_FAILED=1 regenerates all-failed tasks)
bun run grade          # trajectories.jsonl -> graded.jsonl + summary.json (RETRY_FAILED=1 re-grades them)
bun run eval           # scaffold + generate + grade
bun run export-results # graded.jsonl -> results.jsonl
bun run download       # download published artifacts from HF into data/
bun run upload         # upload README.md and data/* to HF
bun run query          # query large JSONL artifacts with clickhouse-local
bun run ab             # 2x2 A/B grid (tool budget x thinking level) on a sample
bun run probe          # partner-probe repro: measure you-search response sizes for the partner-reported >1MB responses
bun run analysis       # tool/skill usage analysis over data/*.jsonl
bun run check          # typecheck + tests
```

## Results

### Full run — 2026-09-12 (cap15 + high thinking + truncation; current defaults)

| | |
| --- | --- |
| Model | `meta/muse-glimmer-30b` (OpenRouter) |
| Thinking level | `high` |
| Tool budget | 15 calls (`MAX_TOOL_CALLS=15`), results truncated at 12k chars |
| Trials / tasks | 2700 trials / 900 tasks (K=3) |
| Average answer F1 (raw) | **0.6653** |
| Average answer F1 (adjusted, 2688 gradable trials) | 0.6683 |
| Trial pass rate (score >= 0.8) | **58.0%** (1566/2700) |
| `exactPassAtK` (task-level, any trial >= 0.8) | **71.22%** (641/900) |
| Trial statuses | 2695 completed (99.8%) / 1 failed / 4 timed out |
| Ungradable trials | 12 |

Cost and process (from `data/summary.json`):

| Metric | Value |
| --- | --- |
| Model cost | $107.17 |
| You.com API cost | $190.04 |
| Total cost | $297.21 |
| Avg total cost / trial | $0.1101 |
| Input tokens | 203.3M |
| Output tokens | 16.3M |
| Avg tool-call events / trial | 31.6 (incl. started+completed events per call) |
| Failed tool-call events (budget-cap blocks) | 5025 |
| Error events | 0 |
| Avg end-to-end latency / trial | 141.2s |

Progress across the three configurations evaluated on this model (all 900 tasks, K=3):

| Run | Trial deaths | Avg F1 (raw) | Trial pass rate | pass@K |
| --- | --- | --- | --- | --- |
| 2026-09-11 initial (registry `maxTokens: 117964`, cap 10, medium) | 37.3% (provider 400s) | 0.4262 | 37.0% | 53.22% |
| 2026-09-11 + maxTokens fix + retry (cap 10, medium) | 22.2% | 0.5341 | 46.4% | 66.78% |
| **2026-09-12 cap15 + high thinking + truncation (current defaults)** | **0.2%** | **0.6653** | **58.0%** | **71.22%** |

Observations for this model, not cross-model conclusions: the A/B-validated levers (15-call budget, high thinking) plus per-result truncation eliminated the trial-death tiers — 99.8% of trials now complete and produce an answer, up from 62.8% in the first run. The remaining failures are almost entirely answer-quality, not harness: fully incorrect 612 (final-step reasoning — barely movable by budget or thinking per the A/B buckets), incomplete set enumeration 374, correct-but-extraneous 131. The next frontier is the model itself or a stronger reasoning/synthesis loop, not harness mechanics.

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
| `THINKING_LEVEL` | generate | `off`..`xhigh` (default `high`, the A/B grid winner) |
| `LABEL` | generate | Run label (defaults to `<model>-you-web`) |
| `JUDGE_MODEL` | grade | LLM judge id (default `deepseek/deepseek-v4-flash-0731`; keep fixed across runs for comparability) |
| `JUDGE_FALLBACK_MODEL` | grade | Judge used if the primary judge call fails (default `qwen/qwen3.6-flash`) |
| `JUDGE_TIMEOUT_MS` | grade | Per-judge-call timeout (default `180000`) |
| `FORCE=1` | generate, grade | Discard prior artifacts for a clean rerun |
| `RETRY_FAILED=1` | generate, grade | Regenerate only tasks whose latest K trials all failed, then re-grade them (used to re-run the provider-400 trials root-caused in `analysis/README.md` §6) |
| `MAX_TOOL_CALLS` | generate | Extension tool-call budget cap (default `15`, the A/B grid winner) |
| `MAX_TOOL_RESULT_CHARS` | generate | Per-tool-result text cap before truncation (default `12000`) |
| `MODELS_PATH` | generate | pi models.json path (default: repo `models.json`, which caps `meta/muse-glimmer-30b` `maxTokens` to 16384 so input + max_tokens stays under the provider's 131072 combined limit) |
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

The Skill text asks the model to stay within ~10 tool calls, but smaller or less instruction-following models ignore that ceiling and tail-chase. Enforcement lives in the extension (`src/extension.ts` + `src/budget-policy.ts`):

- **Hard cap**: tool calls past `MAX_TOOL_CALLS` (default 15, the A/B grid winner over 50 sample tasks: cap15/high scored F1 0.665 / 60% pass vs cap10/medium's 0.586 / 46%) are blocked with an answer-forcing reason that also forbids the candidate-set dump (list ONLY the items that satisfy every criterion — never the intermediate candidate set). Blocked calls return `status: 'failed'` in the trajectory, so the `process` rubric sets `failOnFailedToolCalls: false` — the budget is enforced at runtime by the extension, not re-litigated at grade time.
- **Mid-budget check-in**: once, at the midpoint of the budget, the extension appends a hint to the tool result: how many calls remain, complete set enumerations before answering, and filter the final answer to only criterion-satisfying items.
- **Per-result truncation**: each tool result's text is capped at `MAX_TOOL_RESULT_CHARS` (default 12000) with an omission marker, so accumulated tool content cannot push the model past its context window (the second-order overflow tier in the 2026-09-11 run: trials with 114k+ input tokens hit the 131072 provider window).

Both knobs are env-configurable for A/B testing (e.g. `MAX_TOOL_CALLS=10` reproduces the original cap), and the analysis queries in `analysis/README.md` measure the failure-pattern buckets (fully incorrect / incomplete set / extraneous) these levers target.

## License

MIT.
