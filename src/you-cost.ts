import type { JsonObject } from './io.ts'

const SEARCH_COST_USD_PER_CALL = 5 / 1_000
const PAGE_EXTRACTION_COST_USD_PER_PAGE = 1 / 1_000

export interface YouApiCostSummary extends JsonObject {
  searchCalls: number
  searchExtractionPages: number
  contentsCalls: number
  contentsPages: number
  costUsd: number
  searchCostUsd: number
  searchExtractionCostUsd: number
  contentsCostUsd: number
}

export function estimateYouApiUsage(events: ReadonlyArray<Record<string, unknown>>): YouApiCostSummary {
  // MINIMAL: the RLM v7 stage-2 page reads are internal you-contents fetches
  // executed inside the you-search tool call — they produce no tool_call
  // event, so they are undercounted here (the parallel distill sub-calls' FC
  // usage rides the tool result's usage, which is counted separately from
  // this You.com API estimate). Upgrade path: read
  // `details.rlm.internalContentsCalls` from completed you-search
  // trajectories and add those fetches (plus their URL counts, recorded in
  // details.rlm.stage2.urls) to contentsCalls/contentsPages. Do not build
  // this until the v7 AB quantifies the gap.
  // Group tool_call events by toolCallId. A call is billed iff it reached
  // status 'completed': You.com bills returned results, and hook-blocked
  // calls (budget, full_page steering, repeat-query dedup) never leave the
  // local loop. Error responses return no billable content, so failed
  // executions are also unbilled. Completed events carry no input, so
  // contents URL counts come from the call's started sibling.
  interface CallRecord {
    name: unknown
    input: JsonObject | undefined
    output: JsonObject | undefined
    completed: boolean
    billed: boolean
  }
  const calls = new Map<string, CallRecord>()
  for (const event of events) {
    if (event.type !== 'tool_call') continue
    const id = asObject(event.metadata)?.toolCallId
    const key =
      typeof id === 'string' && id.length > 0 ? id : `${String(event.name)}:${String(event.status)}:${calls.size}`
    const record: CallRecord = calls.get(key) ?? {
      name: event.name,
      input: undefined,
      output: undefined,
      completed: false,
      billed: true,
    }
    const input = asObject(event.input)
    if (input) record.input = input
    if (event.status === 'completed') {
      record.completed = true
      record.output = asObject(event.output)
      // Tool-level errors (MCP isError results — server-side validation
      // rejections, API failures) resolved without billable content: the
      // extension normalizes them into a details.error marker, and
      // API-failure paths carry no results. Mark them unbilled.
      const details = asObject(record.output?.details)
      if (details?.error === true) record.billed = false
    }
    calls.set(key, record)
  }

  let searchCalls = 0
  let searchExtractionPages = 0
  let contentsCalls = 0
  let contentsPages = 0

  for (const record of calls.values()) {
    if (!record.completed || record.billed === false) continue

    if (isYouSearch(record.name)) {
      searchCalls += 1
      searchExtractionPages += countSearchExtractionPages(record.output)
      continue
    }

    if (isYouContents(record.name)) {
      contentsCalls += 1
      contentsPages += countUrls(record.input)
    }
  }

  const searchCostUsd = searchCalls * SEARCH_COST_USD_PER_CALL
  const searchExtractionCostUsd = searchExtractionPages * PAGE_EXTRACTION_COST_USD_PER_PAGE
  const contentsCostUsd = contentsPages * PAGE_EXTRACTION_COST_USD_PER_PAGE
  const costUsd = searchCostUsd + searchExtractionCostUsd + contentsCostUsd

  return {
    searchCalls,
    searchExtractionPages,
    contentsCalls,
    contentsPages,
    costUsd,
    searchCostUsd,
    searchExtractionCostUsd,
    contentsCostUsd,
  }
}

function isYouSearch(name: unknown): boolean {
  return name === 'you-search' || name === 'you_search'
}

// Cost summary for a harness trial row. Recomputes from the trial's embedded
// trajectory events so exports stay consistent when the estimator changes;
// falls back to the generation-time `metadata.youApiUsage` when the row has
// no trajectory (e.g. truncated artifacts).
export function youApiUsageForTrial(trial: Record<string, unknown> | undefined): Record<string, unknown> {
  const trajectory = trial?.trajectory
  if (Array.isArray(trajectory)) {
    return estimateYouApiUsage(trajectory.map((event) => asObject(event) ?? {}))
  }
  return asObject(asObject(trial?.metadata)?.youApiUsage) ?? {}
}

function isYouContents(name: unknown): boolean {
  return name === 'you-contents' || name === 'you_contents'
}

function countUrls(input: JsonObject | undefined): number {
  const urls = input?.urls
  return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string' && url.length > 0).length : 0
}

function countSearchExtractionPages(output: JsonObject | undefined): number {
  const root = asObject(output?.details) ?? asObject(output)
  const results = asObject(root?.results)
  if (!results) return 0

  return countResultsWithFullPageContents(results.web) + countResultsWithFullPageContents(results.news)
}

// Search full_page extraction is billed per extracted web/news result.
// Under `extraction_mode: "full_page"` the API returns crawled page content in
// `contents.markdown` / `contents.html`. Highlights mode (the default) also
// populates `contents`, but only with `highlights` passages, which are free —
// so only html/markdown contents count as billed extraction pages.
function countResultsWithFullPageContents(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return value.filter((result) => {
    const contents = asObject(asObject(result)?.contents)
    if (contents === undefined) return false
    return (
      (typeof contents.markdown === 'string' && contents.markdown.length > 0) ||
      (typeof contents.html === 'string' && contents.html.length > 0)
    )
  }).length
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}
