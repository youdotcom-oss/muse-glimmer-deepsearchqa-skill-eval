// Direction 6: Synthesis of failure vs success patterns across the full trajectory.
// No ClickHouse queries — qualitative synthesis drawing on the quantitative directions.
// Each finding is backed by queries over graded.jsonl; the decisive evidence for the
// primary failure mode came from a single-task reproduction at concurrency=1 that
// surfaced the provider 400 error pi attaches to the final assistant message
// (errorMessage field, not captured by the trajectory collector).

const body = `## 6. Synthesis: failure vs success — root-cause analysis

Headline run: 2700 trials / 900 tasks (K=3), \`meta/muse-glimmer-30b\`, avg F1 0.4262, trial pass rate 37.0%, exactPassAtK 53.2%. This synthesis identifies the dominant cause of poor performance: a deterministic provider 400 error that kills 37.3% of trials before the model writes its final answer.

### Finding 1 (dominant): pi requests a near-full-window max_tokens; the provider rejects the request outright

1006 of 2700 trials (37.3%) failed with \`result.status=failed\`, \`failureKind=harness_error\`, message "No final assistant response generated." All 1006 came from the same generate run; 998 of them ended with a final assistant message of \`stopReason="error"\` and 0 usage tokens.

**Evidence chain (each step a query over \`data/graded.jsonl\`):**

1. **Failure breakdown**: all failures are \`harness_error\` / "No final assistant response generated"; no adapter crashes, no judge failures, 0 error events.
2. **Context overflow refuted**: failed trials' last successful turn peaked at avg 44.5k tokens (median 40.6k) — well BELOW completed trials' avg 74k (max 130.7k). Failures are not running out of window in the usual sense.
3. **Not rate limiting**: failures distribute uniformly across the run (~37–40% per minute, no bursts), and failed trials have FEWER turns (avg 4.0 vs 6.4) and SHORTER durations (44.8s vs 114.4s) than completed trials.
4. **Task-correlated**: 197/900 tasks (22%) failed all 3 trials; 130 more failed 2 of 3 — the same task fails repeatedly, so the trigger is content, not chance.
5. **Reproduces at concurrency=1**: rerunning one all-3-failed task (\`deepsearchqa-106\`) with K=1, CONCURRENCY=1 reproduced the failure deterministically — turns 1–2 succeed (toolUse, 2.2k → 30.7k tokens), turn 3 errors with 0 tokens.
6. **The smoking gun** (from the repro's raw assistant message \`errorMessage\`, which the trajectory collector drops):

\`\`\`
400: Requested token count exceeds the model's maximum context length of 131072 tokens.
You requested a total of 132110 tokens: 43996 tokens from the input messages
and 88114 tokens for the completion.
\`\`\`

The pi model registry entry for \`meta/muse-glimmer-30b\` declares \`contextWindow: 131072\` and \`maxTokens: 117964\`. pi requests \`max_tokens = min(maxTokens, contextWindow - estimatedInput)\` per turn. The upstream provider (Phala via OpenRouter) enforces **input + max_tokens <= 131072** and counts input tokens slightly differently than pi's estimator (here: 1038 more). So whenever the provider's tokenizer counts more input than pi estimates — content-dependent: tables, URLs, unicode — the total crosses 131072 and the request is rejected with a hard 400. Retries resend the same arithmetic and fail identically; the turn produces an empty assistant message; the trial scores 0.

Note the neighboring pi registry entries use \`maxTokens: 16384\`; muse-glimmer's 117964 leaves ~13k of headroom for input only, and none for tokenizer mismatch.

**Impact (queries over graded.jsonl):**

| Metric | All trials | Completed trials only |
|---|---|---|
| Trials | 2700 | 1695 |
| Avg answer F1 | 0.4262 | **0.7081** |
| Trial pass rate | 37.0% | **58.9%** |
| Tasks with a passing trial (pass@K) | 53.2% (479/900) | **68.1%** (479/703) |

197 tasks (22%) never produced a single completed trial and scored 0 at K=3 purely from this mechanism. The model's real answer quality on trials that survive is F1 ~0.71 — the headline 0.426 mostly measures the harness/registry mismatch, not the model.

**Candidate fixes (priority order):**

1. **Custom model override (in-repo, immediate)**: pi supports custom models via \`models.json\` in the agent dir. Add an entry for \`meta/muse-glimmer-30b\` with \`maxTokens\` capped at a sane output size (e.g. 16384). Then \`input + max_tokens\` never approaches the window and the 400 disappears.
2. **Upstream pi fix**: clamp requested max_tokens with safety headroom (e.g. \`contextWindow - estimatedInput - margin\`) and/or audit registry \`maxTokens\` values that sum against \`contextWindow\` with no slack.
3. **Adapter resilience (partial)**: retry cannot help (deterministic 400), but the adapter could surface \`errorMessage\` from the final assistant message in the trial result so future root-causing does not require a repro.

### Finding 2: the 10-call budget cap worked as designed at full scale

The extension-enforced cap (block the 11th+ tool call with an answer-forcing reason) held across 2700 trials: 2463 blocked-call events total (~0.9/trial), 0 error events, and blocked calls average under one per trial — the model typically tries one call past the cap, is blocked, and answers. Within-budget trials score slightly above the run average (avg F1 0.439 for the 0–10 band). The cap is not the bottleneck; the 400 mechanism is.

### Caveats

- Finding 1's per-trial numbers are observational for one model x provider (OpenRouter -> Phala) x harness (Pi); the 400 mechanism may not affect models whose registry \`maxTokens\` leaves headroom.
- The "completed-trials-only" metrics overstate model ability slightly: tasks that never completed skew toward harder questions, so surviving trials are a biased sample.
- The repro evidence (errorMessage) is not in \`data/graded.jsonl\` — the trajectory collector drops \`errorMessage\`; see candidate fix 3.`

export async function run(): Promise<string> {
  return body + '\n'
}

if (import.meta.main) await process.stdout.write(await run())
