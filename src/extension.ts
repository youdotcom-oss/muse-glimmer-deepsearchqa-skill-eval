/** You.com MCP bridge for Pi: dash-cased `you-search` and `you-contents` with RLM-style
 * depth-1 distillation built in. Root-facing surface stays exactly the two pre-work tools;
 * all heavy-content machinery (fan-out sub-queries, schema-constrained distill sub-calls,
 * the bounded grep-explore loop for oversized pages) lives inside the tools. full_page
 * attempts on you-search are intercepted at the tool_call hook with a budget-free steering
 * note.
 *
 * RLM v8: the root decomposes the task and fires ONE you-search call with `sub_queries`
 * (≤4); the extension runs each sub-query's MCP search + one-shot schema-enforced distill
 * in parallel and returns un-merged per-sub-query sections with advisory sufficient/targets
 * verdicts — the root decides to answer, refine, or read a nominated URL itself. Direct
 * you-contents reads beyond one sub-call window are explored by the sub-model via a bounded
 * Bun Shell grep loop, then distilled from the nominated line regions. */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { type CallToolResult, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type TSchema, Type } from 'typebox'
import { createBudgetTracker, readMaxToolCalls, readMaxToolResultChars, truncateText } from './budget-policy.ts'
import {
  addUsage,
  buildDistillPrompt,
  buildExplorePrompt,
  buildQueryRepeatNote,
  EXPLORE_JSON_SCHEMA,
  EXTRACTION_JSON_SCHEMA,
  type ExtractionContract,
  FULL_PAGE_STEERING_NOTE,
  formatExtractionFallback,
  formatExtractionSuccess,
  formatSearchSections,
  formatStructuredExtraction,
  isEmptySearchResult,
  isFullPageSearch,
  normalizeQuery,
  parseExtractionContract,
  QueryDeduper,
  RLM_CONFIG,
  runGrep,
  type SubCall,
  sliceByLines,
  validateExploreAction,
  zeroUsage,
} from './rlm.ts'

const MCP_URL = 'https://api.you.com/mcp?tools=you-search,you-contents'
const CLIENT_INFO = { name: 'deepsearchqa-skill-eval', version: '0.0.0' } as const
const ANY_OBJECT = Type.Object({}, { additionalProperties: true })
const TOOL_NAMES = new Set(['you-search', 'you-contents'])

interface DiscoveredTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

let sharedClient: Client | undefined
let sharedClientPromise: Promise<Client> | undefined
let discoveredTools: DiscoveredTool[] | undefined

function createHeaders(): Record<string, string> {
  if (!process.env.YDC_API_KEY) throw new Error('YDC_API_KEY is required to call the You.com MCP server')
  return { Authorization: `Bearer ${process.env.YDC_API_KEY}` }
}

async function getSharedClient(): Promise<Client> {
  if (sharedClient) return sharedClient
  sharedClientPromise ??= (async () => {
    const client = new Client(CLIENT_INFO)
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: createHeaders() },
    })
    await client.connect(transport)
    sharedClient = client
    return client
  })()
  return sharedClientPromise
}

async function discoverTools(): Promise<DiscoveredTool[]> {
  if (discoveredTools) return discoveredTools
  const client = await getSharedClient()
  const result = await client.listTools()
  discoveredTools = result.tools
    .filter((tool) => TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }))
  return discoveredTools
}

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await getSharedClient()
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

async function closeSharedClient(): Promise<void> {
  const client = sharedClient
  sharedClient = undefined
  sharedClientPromise = undefined
  discoveredTools = undefined
  if (!client) return
  try {
    await client.close()
  } catch {
    // best effort
  }
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
}

function toToolResult(result: CallToolResult): { content: { type: 'text'; text: string }[]; details: unknown } {
  const content = (result.content ?? [])
    .filter(isTextBlock)
    .map((block) => ({ type: 'text' as const, text: block.text }))
  return { content, details: (result.structuredContent ?? {}) as unknown }
}

/** Depth-1 RLM sub-call: an isolated, tool-less completion over the same
 * provider/model as the parent session. One self-contained prompt (no system
 * role); the worker has no tools and no filesystem access, so crawled content
 * cannot trigger actions — it can only shape its own extraction. Output is
 * schema-constrained via response_format (probed live for this model via
 * OpenRouter) when a schema is provided. */
function makeSubCall(ctx: ExtensionContext, signal: AbortSignal | undefined): SubCall {
  return async (prompt, schema) => {
    const model = ctx.model
    if (!model) throw new Error('no active model for the extraction sub-call')
    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
      },
      {
        signal,
        maxTokens: RLM_CONFIG.maxOutputTokens,
        // Extraction sub-calls: reasoning suppressed (span extraction), output
        // hard-capped. The schema carries the shape, not the prose.
        reasoningEffort: 'minimal',
        ...(schema
          ? {
              samplingParams: {
                response_format: { type: 'json_schema', json_schema: { name: 'rlm_output', strict: true, schema } },
              },
            }
          : {}),
      },
    )
    if (response.stopReason === 'error' || response.errorMessage) {
      throw new Error(response.errorMessage ?? `sub-call stopReason ${response.stopReason}`)
    }
    const text = response.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('\n')
    // Schema output should be bare JSON; tolerate a code fence defensively.
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      try {
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
        parsed = fence?.[1] ? JSON.parse(fence[1].trim()) : undefined
      } catch {
        parsed = undefined
      }
    }
    return { text, usage: response.usage, parsed }
  }
}

function extendedParameters(tool: DiscoveredTool): TSchema {
  const base = (tool.inputSchema ?? ANY_OBJECT) as Record<string, unknown>
  const properties = (base.properties ?? {}) as Record<string, unknown>
  const params: Record<string, unknown> = { ...properties }
  if (tool.name === 'you-search') {
    params.sub_queries = {
      type: 'array',
      maxItems: RLM_CONFIG.maxSubQueries,
      items: { type: 'string' },
      description:
        `Optional. Decompose the task into up to ${RLM_CONFIG.maxSubQueries} facet queries (3-6 keywords each, one facet each). ` +
        'Every facet is searched and distilled in this single call; results return as one section per facet, un-merged.',
    }
    params.task = {
      type: 'string',
      description:
        'Optional. The overall task these queries serve (defaults to the session question). ' +
        'Distillation filters facts for relevance against it.',
    }
  }
  return { ...base, properties: params } as unknown as TSchema
}

/** The overall task for distill prompts: session research question → explicit
 * task param → the query itself. */
function buildTask(researchQuestion: string | undefined, taskParam: unknown, query: string): string {
  if (researchQuestion && researchQuestion.trim().length > 0) return researchQuestion
  if (typeof taskParam === 'string' && taskParam.trim().length > 0) return taskParam.trim()
  return query
}

interface FanoutSection {
  query: string
  contract?: ExtractionContract
  raw?: string
}

function buildToolDefinition(
  tool: DiscoveredTool,
  getResearchQuestion: () => string | undefined,
  queryDeduper: QueryDeduper,
): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description:
      (tool.description ?? `Call ${tool.name} on the You.com MCP server.`) +
      (tool.name === 'you-search'
        ? ' Returns highlight excerpts per result. For an in-depth read of a single page, identify the most promising result and call you-contents with its URL.'
        : ''),
    parameters: extendedParameters(tool),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error('You.com MCP call was cancelled')
      const { sub_queries, task: taskParam, ...mcpArgs } = params as Record<string, unknown>
      // Defensive: the tool_call hook steers full_page away; this guarantees
      // you-search MCP calls are highlights even if one slips through.
      if (tool.name === 'you-search') delete (mcpArgs as Record<string, unknown>).extraction
      // Defensive pin: contents is markdown-only — html/metadata formats would
      // bloat the sub-call input, and our sizing is calibrated to markdown.
      if (tool.name === 'you-contents') (mcpArgs as Record<string, unknown>).formats = ['markdown']
      try {
        const result = await callTool(tool.name, mcpArgs)
        const adapted = toToolResult(result)
        if (result.isError) {
          const errorText = adapted.content.length
            ? adapted.content.map((block) => block.text).join('\n')
            : `${tool.name} reported an error`
          return { content: [{ type: 'text', text: `Error: ${errorText}` }], details: { error: true } }
        }

        const rawText = adapted.content.map((block) => block.text).join('\n')
        // Zero-result payloads carry the server's retry guidance (a second
        // text block) written for the ROOT — distilling it would eat the
        // steering. Tiny + pre-structured: pass through.
        if (tool.name === 'you-search' && isEmptySearchResult(adapted.details)) return adapted
        if (!ctx.model) return adapted

        const researchQuestion = getResearchQuestion()
        const query = typeof mcpArgs.query === 'string' ? (mcpArgs.query as string) : ''
        const task = buildTask(researchQuestion, taskParam, query)
        const subCall = makeSubCall(ctx, signal)
        const maxResultChars = readMaxToolResultChars(process.env)
        const adaptedDetails = typeof adapted.details === 'object' && adapted.details !== null ? adapted.details : {}

        onUpdate?.({
          content: [{ type: 'text', text: `[RLM] distilling ${rawText.length} chars in isolated sub-call(s)...` }],
          details: {},
        })
        try {
          if (tool.name === 'you-search') {
            // ---- Fan-out: search + distill every sub-query in parallel. ----
            const requested = Array.isArray(sub_queries)
              ? (sub_queries as unknown[])
                  .filter((q): q is string => typeof q === 'string')
                  .map((q) => q.trim())
                  .filter((q) => q.length > 0)
                  .slice(0, RLM_CONFIG.maxSubQueries)
              : []
            const queries: string[] = []
            for (const candidate of requested) {
              const { duplicate } = queryDeduper.check(candidate)
              if (!duplicate) queries.push(candidate)
            }
            if (queries.length === 0) {
              // Every sub-query was a repeat (or the batch was invalid and the
              // query itself was seen): budget-free refine-or-answer signal.
              return {
                content: [{ type: 'text', text: buildQueryRepeatNote(normalizeQuery(query)) }],
                details: { ...adaptedDetails, rlm: { mode: 'fanout', duplicateBatch: true } },
              }
            }
            const results = await Promise.all(
              queries.map(async (q): Promise<FanoutSection> => {
                try {
                  const searchResult = await callTool('you-search', { query: q })
                  const searchAdapted = toToolResult(searchResult)
                  const searchRaw = searchAdapted.content.map((block) => block.text).join('\n')
                  if (searchResult.isError) return { query: q, raw: `Error: ${searchRaw || 'search failed'}` }
                  if (isEmptySearchResult(searchAdapted.details)) return { query: q, raw: searchRaw || '(no results)' }
                  const distill = await subCall(
                    buildDistillPrompt({ task, query: q, doc: searchRaw }),
                    EXTRACTION_JSON_SCHEMA,
                  )
                  const parsed =
                    distill.parsed === undefined
                      ? { ok: false as const, problem: 'no parseable JSON' }
                      : parseExtractionContract(distill.parsed)
                  if (parsed.ok) return { query: q, contract: parsed.contract }
                  // Prose fallback: never discard the paid search.
                  return { query: q, raw: truncateText(searchRaw, maxResultChars) }
                } catch (error) {
                  return { query: q, raw: `Error: ${error instanceof Error ? error.message : String(error)}` }
                }
              }),
            )
            const text = formatSearchSections(results.map((r) => ({ ...r, rawMaxChars: maxResultChars })))
            const usage = zeroUsage()
            return {
              content: [{ type: 'text', text: formatExtractionSuccess(rawText.length, queries.length, text, false) }],
              details: {
                ...adaptedDetails,
                rlm: {
                  mode: queries.length > 1 ? 'fanout' : 'single',
                  subQueries: results.map((r) => ({
                    query: r.query,
                    contract: r.contract ? 'json' : 'prose',
                    goalStatus: r.contract?.goal_status,
                    facts: r.contract?.facts.length ?? undefined,
                    confidence: r.contract?.confidence,
                    sufficient: r.contract?.sufficient,
                    targetsCount: r.contract?.targets?.length ?? 0,
                  })),
                  originalLength: rawText.length,
                  extractedLength: text.length,
                },
              },
              usage,
            }
          }

          // ---- you-contents: distill the direct read (explore when oversized). ----
          let distillInput = rawText
          let mode: 'single' | 'explore' = 'single'
          let grepRounds = 0
          const usage = zeroUsage()
          if (rawText.length > RLM_CONFIG.chunkChars) {
            mode = 'explore'
            const docLines = rawText.split('\n').length
            let feedback = ''
            let regions: { start_line: number; end_line: number }[] | undefined
            for (let round = 1; round <= RLM_CONFIG.maxGrepRounds; round += 1) {
              const explore = await subCall(
                buildExplorePrompt({ task, guidance: query, round, docChars: rawText.length, docLines, feedback }),
                EXPLORE_JSON_SCHEMA,
              )
              addUsage(usage, explore.usage)
              const action =
                explore.parsed === undefined
                  ? { ok: false as const, problem: 'no parseable JSON' }
                  : validateExploreAction(explore.parsed, docLines)
              if (!action.ok) {
                grepRounds += 1
                continue
              }
              if (action.action.kind === 'grep') {
                // Bun Shell: pattern is a literal argument (injection-safe),
                // document flows in via in-memory stdin redirect.
                const matches = await runGrep(rawText, action.action.pattern, RLM_CONFIG.grepMaxMatches)
                const nextFeedback =
                  matches.length === 0
                    ? `Grep "${action.action.pattern}" matched nothing.`
                    : matches.slice(0, RLM_CONFIG.grepFeedbackChars)
                feedback = feedback ? `${feedback}\n${nextFeedback}` : nextFeedback
                onUpdate?.({
                  content: [{ type: 'text', text: `[RLM] explore round ${round}: grep "${action.action.pattern}"` }],
                  details: {},
                })
                grepRounds += 1
                continue
              }
              regions = action.action.regions
              break
            }
            distillInput = regions
              ? sliceByLines(rawText, regions, RLM_CONFIG.chunkChars)
              : rawText.slice(0, RLM_CONFIG.chunkChars)
          }
          const distill = await subCall(buildDistillPrompt({ task, query, doc: distillInput }), EXTRACTION_JSON_SCHEMA)
          addUsage(usage, distill.usage)
          const parsed =
            distill.parsed === undefined
              ? { ok: false as const, problem: 'no parseable JSON' }
              : parseExtractionContract(distill.parsed)
          const extractedText = parsed.ok
            ? formatStructuredExtraction(parsed.contract)
            : truncateText(distill.text, maxResultChars)
          return {
            content: [
              {
                type: 'text',
                text: formatExtractionSuccess(rawText.length, 1, extractedText, mode === 'explore' && !parsed.ok),
              },
            ],
            details: {
              ...adaptedDetails,
              rlm: {
                mode,
                contract: parsed.ok ? 'json' : 'prose',
                goalStatus: parsed.ok ? parsed.contract.goal_status : undefined,
                facts: parsed.ok ? parsed.contract.facts.length : undefined,
                confidence: parsed.ok ? parsed.contract.confidence : undefined,
                unresolvedGaps: parsed.ok ? parsed.contract.unresolved_gaps : undefined,
                sufficient: parsed.ok ? parsed.contract.sufficient : undefined,
                targets: parsed.ok ? parsed.contract.targets : undefined,
                suggestion: parsed.ok ? parsed.contract.suggestion : undefined,
                grepRounds: mode === 'explore' ? grepRounds : 0,
                originalLength: rawText.length,
                extractedLength: extractedText.length,
              },
            },
            usage,
          }
        } catch (error) {
          // Extraction failure must degrade to raw text (the budget-policy
          // truncation hook caps it), never to a tool error that discards
          // results the call already paid for.
          const message = error instanceof Error ? error.message : String(error)
          return {
            content: [{ type: 'text', text: formatExtractionFallback(rawText.length, message, rawText) }],
            details: { rlmError: message },
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `Error calling You.com MCP tool "${tool.name}": ${message}` }],
          details: { error: message },
        }
      }
    },
  }
}

export default async function youToolsExtension(pi: ExtensionAPI): Promise<void> {
  // Question-aware distillation: capture the session's research question so
  // the sub-model can filter facts for relevance. First prompt wins; the
  // eval sends exactly one.
  let researchQuestion: string | undefined
  pi.on('before_agent_start', (event) => {
    researchQuestion ??= event.prompt
  })

  const tools = await discoverTools()
  // Per-session deduper: exact/near-repeat queries are blocked budget-free at
  // the hook (root calls) and filtered inside fan-out batches (sub-queries).
  const queryDeduper = new QueryDeduper()
  for (const tool of tools) pi.registerTool(buildToolDefinition(tool, () => researchQuestion, queryDeduper))

  // full_page steering: intercept BEFORE budget counting. The attempt is
  // blocked with the identify->extract note as the reason — it never leaves
  // the local loop (no MCP call, no sub-inference) and, like every block,
  // consumes no budget. Budget policy: hard cap (MAX_TOOL_CALLS, default 15)
  // with an answer-forcing block reason; one-time mid-budget check-in hint;
  // per-result truncation (MAX_TOOL_RESULT_CHARS, default 12000).
  // MINIMAL: fan-out sub-queries are N billed searches per tool call — the
  // You.com estimator undercounts (upgrade path: read details.rlm.subQueries
  // from trajectories). See src/you-cost.ts.
  const tracker = createBudgetTracker(readMaxToolCalls(process.env), readMaxToolResultChars(process.env))
  pi.on('tool_call', (event) => {
    if (isFullPageSearch(event.toolName, event.input)) {
      return { block: true, reason: FULL_PAGE_STEERING_NOTE }
    }
    if (event.toolName === 'you-search') {
      const query = (event.input as { query?: unknown } | undefined)?.query
      if (typeof query === 'string' && query.trim().length > 0) {
        const { duplicate, normalized, similarTo } = queryDeduper.check(query)
        if (duplicate) return { block: true, reason: buildQueryRepeatNote(similarTo ?? normalized) }
      }
    }
    return tracker.onToolCall(event.toolName)
  })
  pi.on('tool_result', (event) => tracker.onToolResult(event.content))

  pi.on('session_shutdown', () => {
    void closeSharedClient()
  })
}
