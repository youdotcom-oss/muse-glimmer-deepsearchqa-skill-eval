# Eval-specific adaptations (and what to change when porting to a general pi package)

This repo's extension + skill are tuned for the DeepSearchQA benchmark, where an automated
judge scores the *final answer text* against a gold set (per-item F1, with a strict
Fully-Correct category that fails answers containing extra items). Several behaviors exist
**only because of that measurement context**. This document catalogs them so the skill can
be ported to a general-purpose pi package without carrying eval artifacts — and notes what
to re-enable when you do.

What ports as-is (general-purpose, keep everywhere): depth-1 distillation sub-calls
(tool-less, goal-conditioned), parallel chunk map + merge, deterministic goal-narrowing
(`narrowToGoal`), the structured extraction contract, gap reporting, full_page steering on
`you-search`, defensive param pins (highlights-only search, markdown-only contents), and
the full_page / repeat-query intercept patterns.

## Eval-specific adaptations to revisit when porting

### 1. Citation suppression in the final answer — SKILL-side, deliberately

- **Where**: `skills/you-web/SKILL.md` — Phase 4 ("Answer with ONLY the requested items.
  No URLs, citations, source lists…"), Output Format, and the Citation Quality Rules
  reframed as research discipline.
- **Why (eval)**: the DeepSearchQA rater penalizes answer items not in the gold set
  ("Excessive Answers"); citation-heavy answers baited the judge into counting context as
  excessive (sample task 35: exact gold set, scored 0.35 on extras). The final-answer format
  is therefore minimized to the requested items only.
- **General-purpose port**: **restore citations** — inline `[title](url)` per claim plus a
  trailing `Sources:` section, and the original "Every claim must have a citation" rule.
  Provenance in the answer materially helps human confidence and makes verification easy,
  and there is no automated excessive-item penalty outside the benchmark. Citations are
  already available to the model: the extraction contract deliberately preserves source
  URLs inside `facts` (the sub-call prompts say "names, dates, URLs…"; the merge prompt
  repeats it). Nothing in the extension strips them.
- **If porting, also consider**: ask the extraction contract for per-fact source attribution
  (`{fact, source_url}` pairs) instead of URL-in-prose, so citations survive distillation
  losslessly.

### 2. Dump-path suppression in extraction results — CODE-side, eval-motivated

- **Where**: `src/rlm.ts` `formatExtractionSuccess` / `formatExtractionFallback` (both
  carry a comment: dump paths are internal-only; `details.rlm.dumpPath` keeps them for
  observability in the trajectory).
- **Why**: sampled trials showed raw dump paths (`/tmp/you-dumps-…/012-you-search.md`)
  leaking into the model's final answers as citation markers (0→4 answers per 50 after
  header text invited it). With no root-facing dump tools in the eval surface, the path is
  dead weight and a contamination risk.
- **General-purpose port**: include the dump path in the extraction header AND ship the
  scoped re-inspection tools (`read-dump` with offset/limit, `grep-dump` with char-offset
  matches — both were built, tested, and removed for the eval; see git history). Root gets
  true RLM peek/grep over raw context; paths in results become live references instead of
  noise. Keep the path-scoping (resolveDumpPath) — it is the anti-cheat boundary either way.

### 3. Budget machinery: hard cap, grace window, query dedup — HARNESS-side

- **Where**: `src/budget-policy.ts` (MAX_TOOL_CALLS default 15, GRACE_TOOL_CALLS=4 gap-directed
  extension, exhaustion block reasons), `QueryDeduper` + `buildQueryRepeatNote` in the
  `tool_call` hook.
- **Why**: eval trials need bounded cost and bounded latency; the cap also forces synthesis
  (the answer-forcing block reason).
- **General-purpose port**: make the cap/grace env-configurable or user-settable (the
  machinery is already generic — `createBudgetTracker(maxCalls, maxResultChars, dumpLimit,
  graceLimit)`), and consider replacing the hard block with a softer "answer soon" nudge.
  The budget hint texts have been generalized to domain-neutral phrasing (completeness
  verification + answer hygiene, no set-enumeration or criterion wording).

### 4. Steering texts tuned to the eval's failure modes

- **Where**: `FULL_PAGE_STEERING_NOTE`, the gap-steering recipe in
  `formatStructuredExtraction` ("refining a query toward a gap… you-contents … for
  full-page depth"), `buildQueryRepeatNote`, and the skill's Phase 5 gap accountability.
- **Why**: each maps to a measured failure tier in sample trajectories (gap-blind
  answering, query thrash, full_page transport blowups).
- **General-purpose port**: these are good defaults everywhere; keep them. The only
  eval-flavored phrasing is "list only the items that satisfy every criterion" inside the
  budget-exhausted reason — soften for general use.

### 5. Fixed constants tuned to one model

- **Where**: `RLM_CONFIG` (`minChars` 12k = truncation cap; `chunkChars` 200k ≈ muse's
  131k window at ~2 chars/token; `maxChunks` 8; `maxOutputTokens` 1,800; contract facts
  capped at 10).
- **Why**: the eval pins one model (`meta/muse-glimmer-30b`); constants are deliberately
  not env-configurable so run context stays comparable across commits.
- **General-purpose port**: derive `chunkChars`/`maxOutputTokens` from the active model's
  context window (`ctx.model`), keep the measured ~2 chars/token web-density factor, and
  make the contract's fact cap an option. Sub-call `reasoningEffort: 'minimal'` was
  measured as required for JSON adherence on muse — re-sample per model.

### 6. Tool surface frozen to the eval pair

- **Where**: `src/adapter.ts` tools list; MCP URL pinned to
  `you-search,you-contents`; `formats` pinned to `["markdown"]`.
- **General-purpose port**: the markdown pin is a good default everywhere (density-
  calibrated); expose other formats as opt-in parameters instead of deleting the pin.

## What is NOT eval-specific (port unchanged)

- The RLM core: isolated sub-calls via `ctx.modelRegistry.complete`, inline text in /
  contract out, no tools, no filesystem access (injection containment), parallel map +
  merge, deterministic goal-grep narrowing, deterministic dump lifecycle
  (session_shutdown + stale sweep).
- The interception patterns: hook-block with budget-free steering reasons (full_page,
  repeat queries) — cheaper and more controllable than prompt-only guidance.
- Contract salvage for output-cap truncation, and prose fallback that never discards a
  paid-for result.
- Sub-call usage attached to the tool result (`usage`), so nested-model cost is visible in
  session totals.

## Design rule this catalog follows

The skill teaches behavior; the harness enforces budgets; the extension owns mechanics;
the grader owns measurement. When porting, re-tune the *skill* for the domain (citations,
formatting, domain guidance) and re-derive the *constants* for the model — the extension's
mechanics are domain-neutral and should not need to change.
