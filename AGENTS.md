<coding_guidelines>
# Agent guidance

## Runtime

- Use Bun for TypeScript scripts and package commands.
- Use `uv` for Python scripts. The upload flow is `bun run upload`, which runs `uv run scripts/upload.py`.
- After grading, run `bun run export-results` before a full `bun run upload`. The uploader requires a fresh `data/results.jsonl` so the Hugging Face Dataset Viewer can use flat, stable rows instead of raw heterogeneous harness artifacts.

## Running an evaluation

- `MODEL` is required by `generate`, `grade`, and the adapter; there is no default model. Example: `MODEL=openai/gpt-5-mini bun run eval`.
- The dataset is fixed to `google/deepsearchqa` by default; treat changing it as a template fork, not a per-run knob.
- Start with the one-question smoke from the README before any full run. `FORCE=1` clears prior artifacts; without it, `generate` and `grade` resume from existing `data/` files.
- Do not edit committed evaluation code to chase a bad run's results; record run context (model, thinking level, date, skill version) in the README results section instead.

## Reporting workflow (analysis -> README)

After a completed eval (`bun run eval && bun run export-results`):

1. Run `bun run analysis` to (re)generate `analysis/README.md` from the local `data/*.jsonl` artifacts. `analysis/README.md` is generated output: do not hand-edit it, and do not commit it. Each section is a re-runnable ClickHouse query; individual scripts are runnable standalone (e.g. `bun run analysis/tool-budget.ts`).
2. Read the analysis output for tool-use findings (search/read discipline, parameter compliance, cost drivers, failure patterns). Findings are observational for the evaluated model; do not present them as cross-model conclusions.
3. Update the root `README.md` "Results" section from `data/summary.json`: headline metric, run date, model and thinking level, the summary metric tables, and the cost/latency/tool-use tables. Use the analysis findings to add one or two sentences of interpretation, clearly framed as observations for this run.
4. Keep `README.md` claims tied to `summary.json` and the `data/*.jsonl` artifacts. If a README number cannot be traced to an artifact, fix the number or the artifact, not the prose.

## Querying large eval artifacts

The JSONL artifacts in `data/` can be multi-GB. Do not read them with whole-file APIs such as `Bun.file(path).text()`, `JSON.parse(await file.text())`, or Python `Path.read_text()`.

For lightweight per-trial analysis, prefer `data/results.jsonl` after `bun run export-results`; it is the viewer-safe flat projection of `data/graded.jsonl`. For questions that require raw generated or graded data, prefer the ClickHouse helper:

```sh
bun run query -- --list
bun run query -- summary --dry-run
bun run query -- failures
```

The helper uses `clickhouse-local` and curated read-only SQL presets over the JSONL files. Use `--dry-run` before expensive queries to inspect the SQL and command.

Reference: https://clickhouse.com/docs/concepts/features/tools-and-utilities/clickhouse-local.md

Safety guidance:

- Keep queries read-only.
- Do not start ClickHouse TCP or HTTP listeners.
- Do not query remote URLs or external object stores from ClickHouse.
- Avoid `SELECT *` over `trial.trajectory`; prefer aggregates and `LIMIT`.
- If you add query commands, use `Bun.spawn` or Bun Shell with interpolated arguments. Do not pass user-provided SQL through `bash -c`.
</coding_guidelines>
