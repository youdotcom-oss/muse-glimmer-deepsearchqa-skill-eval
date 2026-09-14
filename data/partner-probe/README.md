# Partner probe analysis: intermittent >1MB you-search responses

**Date:** 2026-09-13 · **Context:** A partner inference runtime exposes the You.com MCP
`you-search` tool to open-weight models (their probe uses `zai-org/GLM-5.2`). Their fixed probe —
*"What is the top story on Hacker News right now? You must use the search tool. Answer with the
exact title and URL."* — intermittently produces a response over 1MB, and their runtime fails
requests at 1MB. Their observed fan-out: 1–4 model-written sub-queries per probe.

**Hypothesis tested:** (a) agentic fan-out — sub-query results add up; (b) extraction mode —
the model sometimes requests `extraction: "full_page"` and a single call blows the limit.

## Findings

### 1. In highlights mode (the default), fan-out cannot reach 1MB

Measured over our full DeepSearchQA eval run (900 tasks, K=3, 32,688 `you-search` calls, all
highlights/default extraction — raw MCP response sizes from `data/graded.jsonl` trajectories):

| Measure | Value |
| --- | --- |
| Per-call response size | p50 42 KB · p99 67 KB · max 350 KB |
| First-round fan-out (median 3 calls, max 15) | p50 135 KB · p99 324 KB · max 764 KB |
| Full-trial totals (10–15 calls) | p50 530 KB · p99 828 KB |
| Trials or rounds exceeding 1MB | **0 of 2,693** |

Sample of 50 query→response-size pairs: `sample-queries.tsv`.

### 2. The partner's exact observed sub-queries: ~173 KB total

Direct MCP calls with the four sub-queries their model wrote, verbatim
(`direct-subqueries.jsonl`):

| Sub-query | Extraction | Size |
| --- | --- | --- |
| top story on Hacker News front page today (`freshness: day`) | default | 48.6 KB |
| site:news.ycombinator.com front page top story (`freshness: day`) | default | 26.8 KB |
| Hacker News front page top post today September 11 2026 (`freshness: day`) | default | 47.5 KB |
| top story on Hacker News front page right now (`highlights`, `knowledge: core`) | highlights | 49.7 KB |
| **Total (4-call fan-out)** | | **~173 KB** |

### 3. Smoking gun: `extraction: "full_page"` on the same query returns 1.7 MB in ONE call

The first observed sub-query re-run with `extraction: "full_page"`:

| Measure | Value |
| --- | --- |
| Single-call response size | **1,733.7 KB** |
| Result count | 60 (30 web + 30 news) |
| Total crawled page markdown | 1,650 KB |
| Largest single pages | timesofindia.indiatimes.com 134 KB · npr.org 133 KB · apnews.com 127 KB |

The same search in highlights mode returns short passages per result (~50 KB total). In
full_page mode every result carries the entire crawled page as markdown — and homepage-type
pages (NPR, AP, ToI) are >120 KB of markdown each. **One full_page sub-query exceeds the
partner's 1MB limit by itself.**

### 4. Agentic probe runs through our agent (highlights only): never over 1MB

The exact probe prompt run 5 times through our pi agent (`meta/muse-glimmer-30b`, `you-search`
as the only tool, matching the partner's surface; `agent-probes.jsonl`):

| Run | Search calls | Total tool bytes | Max single call |
| --- | --- | --- | --- |
| 1 | 9 | 268.6 KB | 57.2 KB |
| 2 | 9 | 318.1 KB | 51.4 KB |
| 3 | 12 | 478.4 KB | 52.8 KB |
| 4 | 16 (3 blocked) | 555.6 KB | 58.8 KB |
| 5 | 12 | 363.3 KB | 59.2 KB |

Our model fans out further than theirs (9–16 calls vs 1–4) and still stays at ~half the limit —
because every call is highlights mode. The model-generated sub-queries look very similar to the
partner's ("Hacker News top story", "site:news.ycombinator.com ..."), confirming the shared
agentic pattern.

## Conclusion

- **Fan-out alone cannot explain >1MB.** Four highlights sub-queries sum to ~173 KB — an order
  of magnitude under the limit. Across 32,688 real eval calls and 2,693 multi-round trials, no
  highlights-mode call or round exceeded 764 KB.
- **`extraction: "full_page"` explains it exactly.** A single full_page call on this very probe
  query returns 1.7 MB (60 results × full crawled-page markdown). The intermittency matches:
  the failing runs are presumably the ones where the model happened to request full_page on a
  sub-query (probe transcripts were unavailable to confirm directly).

## Postscript — 2026-09-14: measured fix for the 1MB constraint (RLM-style tool-layer distillation)

Follow-up experiments on our agent harness (extension wrapping the same MCP tools) demonstrate
that the >1MB problem can be eliminated **without giving up full_page** — and that the
resulting behavior is measurable entirely on the **main-model (root) side**, where the
partner's 1MB inference-request gate lives.

### What the extension does (the pattern to adopt)

- **Search**: forced highlights (full_page attempts are blocked pre-execution with steering;
  the response payload never exceeds highlights size — p99 67KB per our full-run data).
- **Contents**: full page is fetched, then distilled by an isolated sub-model call
  (same model, private scratchpad, no tools) before the result enters the main context.
  If that read is judged thin by the sub-model, one HTML re-fetch + re-distill is attempted.
  One tool call on the wire regardless of internal reads; nested usage accumulates on the
  tool result.
- **Result**: across ~788 tool results per 50-trial sample, raw web payload entering the
  model context was reduced to **1.8–4.3%** of fetched bytes (e.g. 92.3M chars → 1.64M).

### How to measure it (root-side, no sub-call visibility needed)

All quantities below are observable in the **root model's inference requests** — i.e., in
exactly the traffic the partner's 1MB gate polices:

| Metric | Where it appears | Our v5 sample (50 trials) |
| --- | --- | --- |
| Per-tool-result size entering the next root request | the `tool` message content in the request body | capped by distillation (2.3% of raw bytes; ≤ ~12k chars/result) |
| Root input tokens per turn | the inference request's usage | 13.9k–28.7k per trial (vs. 114k+ overflow tier before) |
| Root requests under 1MB | request body size | 100% of requests in our runs; the 1.7MB `full_page` payload class never reaches the root |

With tool-layer distillation in place, the partner can keep their 1MB gate on inference
requests while **re-allowing full_page** (or leaving extraction free): the gate would only
ever see distilled results. The remaining hard constraint we measured is not response size
but *document format* (PDF/XLSX data is unextractable by text crawl — a separate failure
tier, ~3/50 tasks).

### Headline result with this pattern (same 50 tasks, 5 configurations)

Root-model F1 on the primary metric: 0.70 → 0.76 → 0.8054 (latest), pass (Fully Correct)
0.52 → 0.64, contract adherence 98–100%, cost/trial down ~15% from the truncation-only
baseline. Judge: DeepSeek v4.1-flash, official rater semantics (paper Appendix A).

## Recommendations for the partner runtime## Recommendations for the partner runtime

1. **Force `extraction: "highlights"`** in their MCP wrapper for probe/small-context traffic
   (or drop `extraction` from the model-writable parameter surface entirely).
2. Alternatively, cap the tool response size in their wrapper (truncate or reject >1MB) and
   surface a tool error to the model so it can retry with highlights.
3. If full_page is a feature they want to keep, note it is billed per extracted page and sized
   by page content — homepage-heavy result sets are the worst case.

## Appendix: queries used for this analysis

All SQL runs over the eval artifacts with `clickhouse-local` (read-only):

```sh
./clickhouse local --query "$(cat query.sql)"
```

### A. Per-call response size distribution, by extraction mode

Over every completed `you-search` call in the full run (`data/graded.jsonl`, 2,693 completed
trials, 32,688 calls). The trajectory records the RAW MCP tool result — our extension truncates
what the *model* sees at 12k chars, but `tool_execution_end` carries the raw result, so this
measures endpoint behavior:

```sql
SELECT
  coalesce(nullIf(JSONExtractString(JSONExtractRaw(x, 'input'), 'extraction'), ''),
           'default(highlights)') AS extraction,
  count() AS calls,
  round(quantile(0.5)(length(JSONExtractRaw(x, 'output'))), 0) AS bytes_p50,
  round(quantile(0.99)(length(JSONExtractRaw(x, 'output'))), 0) AS bytes_p99,
  round(max(length(JSONExtractRaw(x, 'output'))), 0) AS bytes_max
FROM file('data/graded.jsonl', 'JSONAsString', 'json String')
ARRAY JOIN arrayFilter(
  x -> JSONExtractString(x, 'type') = 'tool_call'
    AND JSONExtractString(x, 'name') = 'you-search'
    AND JSONExtractString(x, 'status') = 'completed',
  JSONExtractArrayRaw(JSONExtractRaw(json, 'trial', 'trajectory'))
) AS x
GROUP BY extraction
ORDER BY calls DESC
```

### B. First-round fan-out totals (the partner's single-probe analog)

Per trial, everything before the first tool message is the model's first fan-out round.
Sums the raw sizes of that round's `you-search` calls, plus per-trial totals:

```sql
WITH trials AS (
  SELECT JSONExtractArrayRaw(JSONExtractRaw(json, 'trial', 'trajectory')) AS evts
  FROM file('data/graded.jsonl', 'JSONAsString', 'json String')
  WHERE JSONExtractString(json, 'trial', 'result', 'status') = 'completed'
),
per AS (
  SELECT
    if(arrayFirstIndex(i -> JSONExtractString(evts[i], 'type') = 'message'
        AND JSONExtractString(evts[i], 'role') = 'tool', arrayEnumerate(evts)) = 0,
       length(evts) + 1,
       arrayFirstIndex(i -> JSONExtractString(evts[i], 'type') = 'message'
        AND JSONExtractString(evts[i], 'role') = 'tool', arrayEnumerate(evts))) AS cutoff,
    evts
  FROM trials
),
per3 AS (
  SELECT
    arrayFilter(x -> JSONExtractString(x, 'type') = 'tool_call'
      AND JSONExtractString(x, 'name') = 'you-search'
      AND JSONExtractString(x, 'status') = 'completed', arraySlice(evts, 1, cutoff - 1)) AS first_round_calls,
    arrayFilter(x -> JSONExtractString(x, 'type') = 'tool_call'
      AND JSONExtractString(x, 'name') = 'you-search'
      AND JSONExtractString(x, 'status') = 'completed', evts) AS all_calls
  FROM per
)
SELECT
  round(quantile(0.5)(length(first_round_calls)), 0) AS fanout_p50,
  round(max(length(first_round_calls)), 0) AS fanout_max,
  round(quantile(0.5)(arraySum(x -> length(JSONExtractRaw(x, 'output')), first_round_calls)), 0) AS firstround_bytes_p50,
  round(quantile(0.99)(arraySum(x -> length(JSONExtractRaw(x, 'output')), first_round_calls)), 0) AS firstround_bytes_p99,
  round(max(arraySum(x -> length(JSONExtractRaw(x, 'output')), first_round_calls)), 0) AS firstround_bytes_max,
  round(countIf(arraySum(x -> length(JSONExtractRaw(x, 'output')), first_round_calls) > 1000000) * 100 / count(), 3) AS pct_firstround_gt_1mb,
  round(quantile(0.5)(arraySum(x -> length(JSONExtractRaw(x, 'output')), all_calls)), 0) AS trial_total_p50,
  round(quantile(0.99)(arraySum(x -> length(JSONExtractRaw(x, 'output')), all_calls)), 0) AS trial_total_p99,
  round(countIf(arraySum(x -> length(JSONExtractRaw(x, 'output')), all_calls) > 1000000) * 100 / count(), 2) AS pct_trial_total_gt_1mb,
  count() AS trials
FROM per3
```

### C. Query → response-size sampling

50 random (query, extraction, approx-result-bytes) pairs. `started` events carry the tool
input and `completed` events carry the raw output, joined by `toolCallId` — this produced
`sample-queries.tsv`:

```sql
WITH trials AS (
  SELECT JSONExtractArrayRaw(JSONExtractRaw(json, 'trial', 'trajectory')) AS evts
  FROM file('data/graded.jsonl', 'JSONAsString', 'json String')
  WHERE JSONExtractString(json, 'trial', 'result', 'status') = 'completed'
),
per AS (
  SELECT
    arrayFilter(x -> JSONExtractString(x, 'type') = 'tool_call'
      AND JSONExtractString(x, 'name') = 'you-search'
      AND JSONExtractString(x, 'status') = 'started', evts) AS starts,
    arrayFilter(x -> JSONExtractString(x, 'type') = 'tool_call'
      AND JSONExtractString(x, 'name') = 'you-search'
      AND JSONExtractString(x, 'status') = 'completed', evts) AS completes
  FROM trials
)
SELECT
  JSONExtractString(s, 'input', 'query') AS query,
  coalesce(nullIf(JSONExtractString(s, 'input', 'extraction'), ''), 'default') AS extraction,
  length(JSONExtractRaw(arrayFirst(
    c -> JSONExtractString(c, 'metadata', 'toolCallId') = JSONExtractString(s, 'metadata', 'toolCallId'),
    completes), 'output')) AS approx_result_bytes
FROM per
ARRAY JOIN starts AS s
WHERE length(completes) > 0 AND JSONExtractString(s, 'metadata', 'toolCallId') != ''
ORDER BY rand()
LIMIT 50
FORMAT TSV
```

### D. Live probe measurements (not SQL — `bun run probe`)

- **Direct sub-queries**: the partner's four observed model-written sub-queries (verbatim, see
  section 2 table) called against the MCP `you-search` endpoint directly, plus a
  `extraction: "full_page"` variant of the first sub-query as the hypothesis test.
- **Agentic probes**: the exact probe prompt run 5 times through our pi agent with
  `you-search` as the only tool; every `tool_execution_end` result is byte-counted per call and
  per run.

Sources: `scripts/partner-probe.ts` (committed), artifacts in this folder
(`direct-subqueries.jsonl`, `agent-probes.jsonl`, `sample-queries.tsv`).

Note: `direct-subqueries.jsonl` contains the raw crawled web content returned by the searches;
any company names appearing inside that raw content are incidental news content, not metadata
added by this analysis.