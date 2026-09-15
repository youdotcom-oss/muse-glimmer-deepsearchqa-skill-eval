# DeepSearchQA Skill Eval Template

A template repository for evaluating chat models on `google/deepsearchqa`. Create a repo from this template, set `MODEL`, and run the full pipeline locally.

**Architecture — this is no longer purely Skill + MCP.** The agent harness runs an **extension** (`src/extension.ts`) that wraps the You.com MCP tools with RLM-style depth-1 extraction: oversized raw tool results are distilled by isolated, tool-less sub-model calls before anything reaches the root model's context. The three layers:

```text
root model (the eval subject; sees only distilled facts + gap notes)
   │  issues you-search / you-contents
   ▼
extension (src/extension.ts) — deterministic tool wrapper
   │  intercepts full_page attempts, repeats, budget overruns (budget-free steering blocks)
   │  RLM distillation sub-calls (ctx.modelRegistry.complete — same model, own scratchpad,
   │  no tools, no fs); HTML retry on thin reads; per-read ledger; usage accumulation
   ▼
You.com MCP server (api.you.com/mcp) — you-search / you-contents
```

Key properties: the root never sees raw web dumps (sampled: 47–92M raw chars/trial-set reduced
to ~2%, 9k+ facts); hook blocks are budget-free; sub-call usage is attached to the tool result
so cost accounting sees nested-model spend; the skill (`skills/you-web/SKILL.md`) teaches only
research judgment — all mechanics are extension-deterministic and invisible to the model. See
`docs/eval-adaptations.md` for the eval-specific-vs-portable catalog.

The pipeline is:

```text
DeepSearchQA dataset
        │
        ▼
scaffold ──► prompts.jsonl ──► generate ──► trajectories.jsonl   (pi session per trial:
                                                │                 root model + extension
                                                ▼                 wrapping MCP tools)
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

### Full run — 2026-09-14 (RLM v5 config: extension distillation + official grading)

Config: RLM depth-1 extraction extension (contract distillation, HTML retry, grace window,
semantic dedup, full_page steering) + generalized skill v2 + judge `deepseek/deepseek-v4.1-flash`
with official rater semantics. **Metric + judge changed this run**: pass = official Fully Correct
category (all parts found, zero excessive); not comparable to earlier F1>=0.8 rows. Full
architecture: see the diagram at the top of this README and `docs/eval-adaptations.md`.

| | |
| --- | --- |
| Model | `meta/muse-glimmer-30b` (OpenRouter) |
| Thinking level | `high` |
| Tool budget | 15 + 4-call gap-directed grace window; results distilled by RLM sub-calls |
| Trials / tasks | 2700 trials / 900 tasks (K=3) |
| **Average F1 (raw) — primary metric** | **0.6910** |
| Average F1 (adjusted, 2688 gradable trials) | 0.6941 |
| **Fully Correct pass rate** (all parts, zero excessive) | **52.8%** (1425/2700) |
| Fully Correct pass@K (task-level, any-of-3) | 65.9% (593/900) |
| FC per task (K=3): 0/3 / 1/3 / 2/3 / 3/3 | 307 / 108 / 138 / 347 |
| Ungradable | 12 trials (3 tasks missing gold in dataset) |
| Trial statuses | 0 failed / 0 timed out — all 2700 graded |

Cost and process:

| Metric | Value |
| --- | --- |
| Total cost | $246.96 ($0.0915/trial, $0.27/task) |
| Model cost | $49.28 |
| You.com API cost | $197.68 |
| Avg end-to-end latency / trial | 268s |
| Tool-call attempts / trial | 42.3 (incl. 10,360 unbilled steering/dedup/budget blocks) |
| Error events | 0 |

### Full run — 2026-09-12 (pre-extension: truncation-only config; old judge + old pass definition)

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

| Run | Trial deaths | Avg F1 (raw) | Pass rate | pass@K |
| --- | --- | --- | --- | --- |
| 2026-09-11 initial (registry `maxTokens: 117964`, cap 10, medium) | 37.3% (provider 400s) | 0.4262 | 37.0% | 53.22% |
| 2026-09-11 + maxTokens fix + retry (cap 10, medium) | 22.2% | 0.5341 | 46.4% | 66.78% |
| 2026-09-12 cap15 + high thinking + truncation (pre-extension) | 0.2% | 0.6653 | 58.0% | 71.22% |
| **2026-09-14 RLM v5 + official grading (current defaults)** | **0%** | **0.6910** | **52.8%** (FC) | **65.9%** (FC) |

**Metric break at the last row**: pass-rate/pass@K switched from F1>=0.8 to the official
Fully-Correct category and the judge changed (v4-flash -> v4.1-flash). F1 (the primary ranking
metric, unchanged definition) improved 0.6653 -> 0.6910 despite the stricter binary definition.
For reference on the same tasks, the F1>=0.8 trial rate in this run was 62.5% (1687/2700).

Observations for this model, not cross-model conclusions: the A/B-validated levers (15-call budget, high thinking) plus per-result truncation eliminated the trial-death tiers — 99.8% of trials now complete and produce an answer, up from 62.8% in the first run. The remaining failures are almost entirely answer-quality, not harness: fully incorrect 612 (final-step reasoning — barely movable by budget or thinking per the A/B buckets), incomplete set enumeration 374, correct-but-extraneous 131. The next frontier is the model itself or a stronger reasoning/synthesis loop, not harness mechanics.

### 50-task sample re-run — 2026-09-14 (RLM v4: HTML retry + cleaned-document scan + generalized skill)

Same 50 tasks; changes since v2: semantic query dedup, zero-result passthrough, server-rejection
unbilling, conditional HTML retry for interactive pages (thin read -> html re-fetch -> body-only
attribute-stripped scan via streaming rewriter -> re-distill, keep the better), skill generalized
(dataset residue stripped) and stripped of non-actionable mechanics per audit.

| | RLM v2 | **RLM v4** |
| --- | --- | --- |
| Avg F1 (raw) | **0.7603** | 0.7122 |
| Pass (Fully Correct) | 0.58 | 0.52 |
| Latency / trial | 242s | **214s** |
| Cost / trial | $0.092 | $0.092 |
| Contract JSON | 98% | 98% (763/781) |
| Extraction density | 4.3% | **1.8%** (92.3M raw -> 1.64M to root) |
| HTML retries | — | 0 fired (interactive URLs rare in this sample) |

Paired vs v2: +5 gains (incl. former refusers 13/21 again, plus 25/44/45) / −8 regressions. With v3's
0.6989, three same-config-family samples give 0.70-0.76 — a ±3-task run-to-run band at n=50 K=1 that now
exceeds any single lever's effect. Dedup blocks 220 (v3: 270), grace used 86. Sample iteration has hit
its resolution floor; the discriminating experiment is the full 900x3 run on one config. v2's config is
the recorded leader; the HTML retry is kept as correct-by-construction (0 fired here but free when a
dashboard does appear).

### 50-task sample re-run — 2026-09-14 (RLM v5: sub-model-verdict HTML retry gate)

Same 50 tasks; changes since v4: the URL-shape heuristic (isInteractiveDataUrl) deleted —
the HTML retry gate is now the sub-model's verdict alone (not_found or zero facts from any
page, markdown-first, exactly one retry, HTML scanned to bare structure before the fresh
sub-call). New details.rlm.reads ledger records per-read format/facts/winner.

| | RLM v2 | RLM v4 | **RLM v5** |
| --- | --- | --- | --- |
| Avg F1 (raw) | 0.7603 | 0.7122 | **0.8054** |
| Pass (Fully Correct) | 0.58 | 0.52 | **0.64** |
| Latency / trial | 242s | 214s | 227s |
| Cost / trial | $0.092 | $0.092 | **$0.088** |
| Contract JSON | 98% | 98% | **100%** (747/747) |
| Extraction density | 4.3% | 1.8% | 2.3% |
| HTML retries fired | — | 0 | 0 (markdown sufficed on all reads) |

Best recorded sample result on every column. Paired vs v4: +7 gains / −1 regression (17 of 21
non-FC v4 trials still failed here — the band persists). Retry fired 0 times: markdown reads
sufficed again, so the improved gate is measured only as simpler-not-worse. Cumulative v1→v5
trajectory (same tasks): 0.5341-equivalent truncation baseline -> 0.8054 on the primary metric,
with extraction density 4.3% -> 2.3% and cost/trial down ~15%. Caveat unchanged: n=50 K=1,
variance band ±3-4 tasks; the full 900x3 run on this config is the decision point.

### 50-task sample re-run — 2026-09-14 (RLM v6: question-aware distillation)

Same 50 tasks; changes since v5: the distillation goal is now question-aware — the extension
captures the session's research question and composes the default goal with it, so sub-models
filter facts for relevance instead of extracting generically. (Motivation: full-run analysis
found 8,074 blind-goal contents calls whose sub-model gaps literally asked for the question,
and the always-zero failure cluster answered with dataset schema dumps instead of the requested
data.) Root system-prompt override also removed — pi's default prompt + the skill now carry
behavior, matching real deployment.

| | RLM v5 | **RLM v6** |
| --- | --- | --- |
| Avg F1 (raw) | **0.8054** | 0.7390 |
| Pass (Fully Correct) | 0.64 | 0.62 |
| Latency / trial | 227s | 260s |
| Contract JSON | 100% | 100% |
| Generic-goal gap notes | pervasive | **0** |
| Extraction density | 2.3% | 1.6% |

The target mechanism verified: generic-goal gap notes ('research question not specified')
dropped from pervasive to zero, and extraction density dropped to 1.6% (tighter relevance
filtering). F1 moved 0.8054 -> 0.7390 — paired mean delta -0.060 with sd 0.297 (se 0.042,
n=50): within the noise band, not a significant regression. Interpretation: question-aware
distillation extracts *less* but the FC pass held at 0.62 (vs 0.64), so the tighter filtering
did not cost completeness on this sample. The F1 delta is consistent with fewer tangential
facts being counted as excess... but the five-config spread (0.71-0.81) at n=50 remains
dominated by run variance. Decision for the full run: keep question-aware goals (mechanism
verified, no measured harm) or revert to v5's blind goal (best recorded F1). Full 900x3 run
resolves it at real significance.

### 50-task sample re-run — 2026-09-14 (RLM v7: two-stage sufficiency-gated distillation, commit 8da8f52)

Same 50 tasks; changes since v5 (TWO variables changed — attribution is cautious): (1) the
you-search distillation is now two-stage and sufficiency-gated — stage 1 judges sufficiency
relative to the task (meta-query) and its own query, and when insufficient nominates 1–3
URLs that the extension reads via one internal you-contents fetch + parallel distill
sub-calls, collated deterministically (stage-2 facts first, cap 12; worst stage-2 status;
min confidence); (2) the ROOT runs at THINKING_LEVEL=xhigh (v5/v6 used high). Sub-calls run
at reasoningEffort medium (was minimal). Deleted: HTML retry/scan, chunk+map merge, reads
ledger. Stage-2 internal fetches are not visible as tool_call events (MINIMAL estimator gap
recorded in src/you-cost.ts; details.rlm.internalContentsCalls carries the count).

| | RLM v5 | **RLM v7** |
| --- | --- | --- |
| Avg F1 (raw) | **0.8054** | 0.7054 |
| Pass (Fully Correct) | **0.64** | 0.52 |
| Latency / trial | 227s | 413s |
| Cost / trial | $0.088 | **$0.087** |
| Tool calls / trial | 42.5 | 42.0 |
| Contract JSON (distilled searches) | 100% (747/747) | 96.5% (656/680) |
| Stage-2 gate rate | — (n/a) | 69.9% of searches (488/698) |
| Internal contents fetches | 0 | 488 (1,186 URLs; 2.43/fetch) |
| Root-initiated you-contents calls | — | 136 (180 pages) |
| Extraction density | 2.3% | 1.9% |
| Outcomes (FC / incomplete / wrong / ungradable) | — | 26 / 15 / 5 / 4 |

Paired vs v5: mean per-task F1 delta −0.098 (sd 0.329, se 0.047, n=50), 6 task gains / 15
losses, pass flips +4/−10. Observations for this run (not cross-model conclusions): the
gate fired on 46/50 trials (avg 9.8 gated searches per trial), so stage 2 is a major
cost/latency surface — latency nearly doubled (+186s/trial), consistent with ~10 serial
rounds of internal fetch + parallel medium-reasoning distills (plus the root's xhigh
thinking; the two effects are not separable on this sample). Cost/trial stayed flat
($0.087): the added sub-call tokens are cheap FC usage, and the 488 internal You.com
fetches are unbilled in the estimator (see MINIMAL note). 85% of collated stage-2 results
read `not_found` (414/488) — the worst-of-stage-2 status semantics is pessimistic when any
one of up to 3 target reads comes back empty, which may over-signal gaps to the root. F1
and FC regressed vs v5; with two changed variables and the n=50 band (±3–4 tasks), the
xhigh-root-vs-gate attribution and the retry decision need a decomposition run (v7 gate at
THINKING_LEVEL=high) before any full-run commitment.

### 50-task sample re-run — 2026-09-15 (RLM v8: sub_queries fan-out + schema-enforced sub-calls + grep-explore, commits 4115107/31a9482)

Same 50 tasks; root at THINKING_LEVEL=high (v7's xhigh reverted — one design change per run vs v5, nominally).
Changes since v5: (1) `you-search({query, sub_queries≤4, task})` fan-out — extension fires each facet's MCP
search + one-shot distill in Promise.all, returns UN-MERGED sections with advisory sufficient/targets; (2)
sub-call output schema-constrained via response_format json_schema (probed live for this model via OpenRouter);
(3) oversized you-contents docs explored by a bounded sub-model Bun-Shell grep loop (3 rounds max) then one
region distill; (4) regex machinery deleted (narrowToGoal/STOP_WORDS, parse/salvage, buildDefaultGoal); (5)
skill rewritten for the new signature.

| | RLM v5 | RLM v7 | **RLM v8** |
| --- | --- | --- | --- |
| Avg F1 (raw) | **0.8054** | 0.7054 | 0.2626 |
| Pass (Fully Correct) | **0.64** | 0.52 | 0.12 (6/50) |
| Latency / trial | 227s | 413s | 128s |
| Cost / trial | $0.088 | $0.087 | $0.102 |
| Tool calls / trial | 42.5 | 42.0 | 50.7 |
| Completed root searches | 689 | 698 | 1,141 |
| Root calls with sub_queries | — | — | 13/1,141 (fan-out barely fired) |
| Facts per sub-query (fanout) | — | — | 5.5 mean |
| Root you-contents calls | ~180 | 136 | 127 (8 grep-explore batches, rounds 1–3) |

Mechanism verified end-to-end (all 50 trials completed, 0 rlmError, schema adherence ~99.7%, grep-explore fired
8 times with 1–3 rounds), but the result is a collapse, not a regression: 32 big paired regressions vs v5, 2
gains. Observations for this run: fan-out canNOT explain the drop (13/1,141 calls used it); the dominant path
was single-query searches distilled under the NEW regime — strict response_format json_schema under
reasoningEffort minimal with a prompt that lost the explicit "preserve exact figures/names/URLs" instruction.
Answer inspection shows well-formed but vaguer answers (≈ ranges vs exact figures), wrong candidate universes,
and premature "cannot be verified" — an extraction-CONTENT collapse, not a formatting one; constrained
sampling degrading this model's span extraction is the leading suspect, possibly interacting with suppressed
reasoning. Notably latency fell (128s) and searches rose 66% — the root searched more and worked less deep.
Next: decomposition run isolating response_format (v8 harness, schema OFF, prose prompts) before any further
design iteration; the v7-vs-v8 diff bundles too many variables to attribute without it.

### 50-task sample re-run — 2026-09-14 (RLM v3: semantic dedup + retrieval-breadth skill)### 50-task sample re-run — 2026-09-14 (RLM v3: semantic dedup + retrieval-breadth skill)### 50-task sample re-run — 2026-09-14 (RLM v3: semantic dedup + retrieval-breadth skill)### 50-task sample re-run — 2026-09-14 (RLM v3: semantic dedup + retrieval-breadth skill)

Same 50 tasks; changes since v2: Jaccard paraphrase dedup (>=0.8), zero-result passthrough
(server retry guidance reaches the root), server-rejection unbilling, skill enumeration
protocol + structural-change-over-rewording + interactive-data awareness, dataset-derived
residue stripped from skill/policy texts.

| | RLM v2 | **RLM v3** |
| --- | --- | --- |
| Avg F1 (raw, primary metric) | **0.7603** | 0.6989 |
| Pass (Fully Correct) | 0.58 | 0.52 |
| Latency / trial | 242s | **205s** |
| Cost / trial | $0.092 | **$0.088** |
| Contract JSON rate | 98% | 98% |
| Dedup blocks | 0 | 270 (80 grace hints) |

v3 result: **regression, within run-to-run variance band.** Paired vs v2: +3 gains (incl. two
former zero-progress refusers, 13 and 21 — gap accountability working) but −6 losses, three of
which collapsed to near-zero with plausible-looking research trajectories (New Zealand vs
Australia country-selection error; PDF-only sources unreachable by text crawl). Dedup blocked
270 attempts, and failing trials still averaged more calls than passes — the dedup redirected
effort but did not convert it into better sources. Reads: (a) 50-task K=1 variance is large
(±3-6 tasks per re-run observed across v1/v2/v3 pairs); (b) semantic dedup may cost useful
reformulations at 0.8 threshold; (c) the dominant failure tier (unreachable PDFs/data portals,
JS-rendered data) needs capabilities the text-crawl surface cannot provide. No config change
from this single run alone; the honest next step is a full-run decision on the best recorded
config (v2 by mean, v3 by latency/cost) with the new judge + FC metric.

### 50-task sample re-run — 2026-09-14 (RLM v2: contract fixes + grader alignment + skill v2)### 50-task sample re-run — 2026-09-14 (RLM v2: contract fixes + grader alignment + skill v2)

Same 50 tasks as the first RLM sample; changes: extraction facts capped at 10, output cap 1,800,
truncated-contract salvage, merge-prompt contract, markdown formats pin, dump-path suppression, 4-call
gap-directed grace window, repeat-query dedup, judge `deepseek/deepseek-v4.1-flash` with the official
excessive-answer definition, skill Phase 4 answer discipline + Phase 5 gap accountability.
**Metric definition + judge changed this run**: pass now reports the official Fully Correct category
(paper Section 3.1), so pass columns are not comparable to earlier rows.

| | RLM v1 (2026-09-14) | **RLM v2** |
| --- | --- | --- |
| Avg F1 (raw, primary metric) | 0.6985 | **0.7603** (+8.9% relative) |
| Pass rate (official Fully Correct) | — | 0.58 |
| Latency / trial | 211s | 242s |
| Cost / trial | $0.077 | $0.092 |
| Contract JSON rate | 82% | **98%** (salvage+cap+merge fix) |
| Extraction density (raw→root) | 4.3% | **2.4%** (70.1M→1.68M chars) |
| Sub-call avg output | 1,106 tok | **804 tok** |
| Answers with dump citations | 4 | **0** |

Paired vs v1: +5 task gains (all four named answer-pollution failures converted: 17, 27, 35, 24, plus refuser 9), −5 regressions (four are missing-tail/hedging — the paper's under-retrieval mode; one is a new-judge calibration case at F1 0.899). Grace window actively used (82 extensions). Next: full-run decision on this config.

### 50-task sample — 2026-09-14 (RLM depth-1 extraction vs. the cap15/high baseline cell)### 50-task sample — 2026-09-14 (RLM depth-1 extraction vs. the cap15/high baseline cell)

Same first-50 tasks, K=1, same cell config (`MAX_TOOL_CALLS=15`, `THINKING_LEVEL=high`); RLM adds in-tool distillation sub-calls (goal-conditioned, JSON contract, output-capped), internal dumps with goal-grep narrowing, full_page steering, and repeat-query dedup. Artifacts: `data/ab/rlm-cap15-high-*` (gitignored; local). n=50, single model — directional, not significant.

| | baseline cap15/high | RLM cap15/high |
| --- | --- | --- |
| Avg F1 (raw) | 0.6647 | **0.6985** (+5.1% relative) |
| Trial pass rate | 0.60 | 0.58 |
| Avg end-to-end latency | 109.5s | 211.4s |
| Avg total cost / trial (You.com billed completed-only) | $0.103 | **$0.077** |

Process notes from the RLM cell trajectory: 665 extractions (82% JSON contract), 47.2M raw chars distilled to 2.0M chars entering root context (4.3%), 9,138 facts; modes 632 single / 26 narrowed / 7 chunked; sub-call avg output 1,106 tokens with 0 reasoning; 111 budget blocks, 0 full_page attempts (description guidance prevented all), 0 repeat-query blocks. The latency premium (~+93%) is the cost of the distillation layer; the cost drop comes from completed-only billing plus fewer billable calls reaching the API.

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

## Porting this skill to a general pi package

The extension + skill here are tuned for benchmark grading. `docs/eval-adaptations.md`
catalogs every eval-specific behavior — answer-format suppression (citations/URLs held out
of final answers because the official rater penalizes extra items), dump-path suppression
in extraction results, budget/grace/dedup machinery, model-tuned constants — and what to
re-enable when porting to a real pi package (restore inline citations + a Sources section,
re-expose the scoped `read-dump`/`grep-dump` re-inspection tools, derive chunk sizing from
the active model's context window). The RLM core — distillation sub-calls, goal-grep
narrowing, steering intercepts, contract salvage — is domain-neutral and ports unchanged.

## License

MIT.
