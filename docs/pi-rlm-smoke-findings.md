# pi-rlm smoke findings (1 task, 2026-09-15)

Commit at smoke time: `0cedb1b` (vendor + loader; budget exemption; pure-port restore).
Model `meta/muse-glimmer-30b`, thinking `high`, `MAX_TOOL_CALLS=15`, K=1, task
`deepsearchqa-0`. Artifacts: `data/ab/rlm-pirlm-smoke-{traj,graded,summary}.jsonl`,
`data/ab/rlm-pirlm-smoke-summary.json`. Scoring is unchanged (raw avg 1.0, FC pass).

## Verified

- `repl`, `rlm`, `you-search`, `you-contents` all register and are simultaneously
  root-callable in a headless SDK session. `createAgentSession` does not fire
  `session_start`; `createPiSession` drives `bindExtensions` to make it happen, and
  `disposePiSession` emits `session_shutdown` so pi-rlm's Python sandbox tears down and
  the adapter exits (8s probe; without it the adapter hung past 480s).
- pi-rlm's native prompt IS applied: the captured provider payload contains
  `NATIVE RLM MODE — YOU ARE AN ORCHESTRATOR` and the full `repl({code})` glossary, and
  `tools = [you-search, you-contents, rlm, repl]`.
- Cost/latency: **$0.1385/trial** (under the $0.18 ceiling), 82s, model $0.0635 +
  You.com $0.075.

## Not working (integration gaps, not package bugs)

1. **The `you-web` skill never reaches the model — in ANY run of this harness.**
   `buildSystemPrompt` appends skills only when `read` or `bash` is in the tool
   allowlist (`skillFileReadTool = ["read","bash"].find(...)`); the adapter allowlist is
   `you-search`/`you-contents` (`+repl`/`rlm`), and `systemPromptOverride` takes the
   `customPrompt` path where `formatSkillsForPrompt` is skipped. `additionalSkillPaths`
   loads the SKILL.md into the resource loader but its body is never inlined, and even
   pi's metadata listing would only tell the model to `read` the file — a tool it does
   not have. Grep of the captured payload: 0 hits for `Search Pipeline`, `Snippets
   alone`, `always read at least one page`. Consequence: decision 6's skill A/B is
   currently vacuous, and the reported v2–v8 "skill" effects were not skill effects.
2. **pi-rlm's native prompt is repo/file-oriented and never mentions the web tools.**
   Its routing table is `search`/`grep_context`/`outline`/`map_files`/`rlm_query` over a
   seeded working directory, with examples like `src/x.ts`. On a web-research task the
   root rationally ignored `repl`.
3. **The run confirms it:** 34 `you-search` + 2 `you-contents` tool events, **0 `repl` /
   0 `rlm` calls**; 15 completed searches (cap), one late `you-contents` blocked. The
   root answered directly from snippets.
4. **Repo seeding is on** (`autoSeedCwd: true`). Had `repl` fired, the first call would
   have pulled the whole repository into the sandbox — irrelevant for a web task.
5. **Global side effect observed:** `~/.pi/agent/rlm-skillstate.json` was created with one
   note under the repo's project fingerprint. All trials share the harness cwd, so
   SkillState accrues cross-trial once `repl`/`rlm` runs — a trial-independence confound
   for the 50-task run.

## Recommendation

Do **not** port pi-rlm into a custom extension yet. The package is wired correctly; the
scaffold simply never engages because (a) the skill is invisible and (b) the repl's
retrieval seam is local-file-only, so there is no token-cheap way for the sandbox to
touch the web. Porting would reimplement the v5-style scaffold the v6→v8 series already
showed degrades on this model, and would invalidate the "adopt pi-rlm" decision.

Cheap sequence before any 50-task run:

1. Inline `skills/you-web/SKILL.md` into the system prompt (pi-session) so the skill is
   actually seen, and add an explicit web-REPL orchestration section to it.
2. Set `autoSeedCwd: false` (and `contextLoader: false`) in `~/.pi/agent/rlm.json`.
3. Re-smoke and check whether `repl`/`llm_query` fire.

Only if the scaffold still does not engage is a search seam (patch the vendored sandbox
bridge with a `web_search()` host handler) or a purpose-built extension worth pricing.

## Follow-up smokes (same task, integration fixes applied)

### Smoke 2 — `2ac603e` (skill inlined; autoSeedCwd/contextLoader off)

| tool | calls |
| --- | --- |
| you-search | 34 (15 completed) |
| rlm | 2 |
| you-contents | 2 |

F1 1.0, **$0.1685**, 111s. The root used pi-rlm's top-level `rlm` tool (a recursive
child engine over the sandbox `context`, i.e. repo files), not `repl`. With an empty
context it searched for the crime-index terms, found nothing, and returned
"no files loaded" after 56s. Worse, the final answer cited a SkillState note distilled
by smoke 1 (`~/.pi/agent/rlm-skillstate.json`) — cross-trial contamination confirmed.

Fixes (`d2941d6`): expose only `repl`; isolate `PI_CODING_AGENT_DIR` per adapter process.

### Smoke 3 — `d2941d6` (repl only, SkillState isolated)

| tool | calls |
| --- | --- |
| repl | 56 events (28 cells) |
| you-search | 48 events (15 completed) |
| you-contents | 8 events (4 completed) |

**F1 0.0**, **$0.2956/trial (over the $0.18 ceiling)**, 146s. The scaffold finally
engaged — then hurt. Cell 2 asked `llm_query` to "list OECD countries ... and give the
crime-index changes" with no source text in the prompt; `llm_query` has no web access,
so the workers confabulated. Later cells called `search()`/`grep_context()` over the
empty sandbox context. The root answered "Ireland" (wrong; smoke 1/2 found New Zealand).

## Updated conclusion

pi-rlm's REPL only pays off when the sandbox already holds the evidence. This harness
has no web→sandbox seam, so when the scaffold engages the root either (a) runs `rlm`
over an empty repo context or (b) delegates to `llm_query` with no embedded evidence —
both waste real money, and (b) is actively harmful. The smoke-3 cost also breaches the
experiment's $0.18/trial ceiling.

Do **not** run the 50-task sample as configured. Options, cheapest first:

1. **Abandon pi-rlm** and record the ceiling conclusion at the mechanism level
   (engaged usage is worse and over budget).
2. **Build the web seam in our extension** (no package fork): persist each
   `you-search`/`you-contents` result to files under a run-local evidence dir, return
   the path in the tool result, and have the skill instruct `add_context(<dir>)` then
   `map_files`/`rlm_query(paths=...)` so sub-LLMs read real evidence. This is the
   faithful "RLM over web" integration and the only path that can plausibly beat raw
   MCP.
3. **Port a purpose-built mini-REPL** into our own extension. Largest effort, and it
   re-tests the v5-style scaffold the v6→v8 series already showed degrades.
