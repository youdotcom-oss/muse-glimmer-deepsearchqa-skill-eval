# DeepSearchQA Skill Eval Template

A harness for evaluating chat models on `google/deepsearchqa`: pi sessions run You.com
MCP tools, and answers are graded with the official DeepSearchQA rater.

The harness is intentionally thin. The agent is a stock pi session loading the upstream
[`@youdotcom-oss/pi`](https://github.com/youdotcom-oss/agent-skills) extension; its bundled
`you-web` skill is passed **directly into the system prompt**, and `read` is withheld so the
model cannot open the answer key in `data/prompts.jsonl`.

## What we found

Three scaffold generations were evaluated against a fixed local-weight root
(`meta/muse-glimmer-30b` via OpenRouter) on the same 50-task K=1 samples (and two full
900-task × 3-trial runs):

| configuration | F1 (raw) | FC pass | notes |
| --- | --- | --- | --- |
| **RLM v5 custom extension** | **0.8054** / 0.6910 (900×3) | 64% / 52.8% | best recorded; hand-built distillation |
| Raw MCP port (`8a7588d`) | 0.6647 | 60% | no extension |
| `@youdotcom-oss/pi`, all tools | 0.5421 | 44% | `read` on (unsafe config) |
| `@youdotcom-oss/pi`, skill injected | 0.5000 | 46% | `read` off |
| `@youdotcom-oss/pi`, `you-search` + `you-contents` | 0.4788 | 40% | two tools only |
| `@hicaru/pi-rlm` scaffold | 0.0 | 0% | failed experiment |
| RLM v6 / v7 / v8 | 0.7390 / 0.7054 / 0.2626 | | deeper sub-model autonomy degrades |

Full history, configs, and paired analysis: [`docs/experiment-log.md`](docs/experiment-log.md).

## Limits identified

The remaining constraints are structural, not tuning knobs:

- **The model, not the tools, is the ceiling.** Adding tools, skills, budget, or deeper
  scaffold autonomy moved the 50-task score within run-to-run noise (±0.05) or worse. The
  root over-searches (500–650 calls on the two-tool run) and under-synthesises.
- **Skills are weak leverage here.** pi surfaces a skill only when a file-reading tool is
  active — and that tool is an eval-integrity hole (it can read the expected answers).
  Passing the skill body directly into the prompt is the only safe mechanism, and it did
  not move the score.
- **MCP content is not the bottleneck.** Raw, truncated, highlighted, distilled, and
  full-page reads all land in the same band once synthesis is the limiting step.
- **More autonomy hurts this root.** The monotonic v6→v8 slide and the pi-rlm failures show
  that handing a local-weight model more recursive control degrades outcomes.

**Conclusion: this is the ceiling of the skill + MCP + pi stack for this model. Better
performance would require a different agent architecture** — a stronger root model, or a
purpose-built retrieve → verify → synthesise loop with explicit state — not more skill,
tool, or scaffold tuning.

## Quick start

Install Bun and uv, then configure credentials:

```sh
bun install
export OPENROUTER_API_KEY=...
export YDC_API_KEY=...
```

Smoke, then full run:

```sh
MODEL=<org>/<model> FORCE=1 LIMIT=1 K=1 CONCURRENCY=1 bun run eval
MODEL=<org>/<model> caffeinate -dimsu bun run eval
bun run export-results && bun run upload
```

`MODEL` (an OpenRouter id, e.g. `minimax/minimax-m3`) is required by `generate`, `grade`, and
the adapter. The dataset is fixed to `google/deepsearchqa`.

## Commands

```sh
bun run eval           # scaffold + generate + grade
bun run scaffold       # DeepSearchQA -> data/prompts.jsonl
bun run generate       # prompts.jsonl -> trajectories.jsonl (RETRY_FAILED=1 regenerates all-failed tasks)
bun run grade          # trajectories.jsonl -> graded.jsonl + summary.json
bun run export-results # graded.jsonl -> results.jsonl
bun run download       # download published artifacts from HF into data/
bun run upload         # upload README.md and data/* to HF
bun run query          # query large JSONL artifacts with clickhouse-local
bun run ab             # 2x2 A/B grid (tool budget x thinking level) on a sample
bun run probe          # partner-probe repro: measure you-search response sizes
bun run analysis       # tool/skill usage analysis over data/*.jsonl
bun run check          # typecheck + tests
```

## Docs

- [`docs/experiment-log.md`](docs/experiment-log.md) — every recorded run, config by config
- [`docs/reference.md`](docs/reference.md) — metrics definitions, artifact querying, env vars, publishing
- [`docs/eval-adaptations.md`](docs/eval-adaptations.md) — eval-specific vs portable catalog
- [`docs/pi-rlm-smoke-findings.md`](docs/pi-rlm-smoke-findings.md) — the failed `@hicaru/pi-rlm` investigation

## License

MIT.
