# Reference

Operational reference extracted from the README (content preserved verbatim).

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
