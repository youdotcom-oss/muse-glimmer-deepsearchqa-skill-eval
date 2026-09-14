/** You.com MCP bridge for Pi: dash-cased `you-search` and `you-contents` with RLM-style
 * depth-1 extraction built in. Root-facing surface stays exactly the two pre-work tools;
 * all heavy-content machinery (internal dumps, deterministic goal grep, distillation
 * sub-calls) lives inside the tools. full_page attempts on you-search are intercepted
 * at the tool_call hook with a budget-free steering note. */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { type CallToolResult, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type TSchema, Type } from 'typebox'
import { createBudgetTracker, readMaxToolCalls, readMaxToolResultChars } from './budget-policy.ts'
import {
  buildQueryRepeatNote,
  DumpStore,
  FULL_PAGE_STEERING_NOTE,
  formatExtractionFallback,
  formatExtractionSuccess,
  formatStructuredExtraction,
  isEmptySearchResult,
  isFullPageSearch,
  narrowToGoal,
  parseExtractionContract,
  QueryDeduper,
  RLM_CONFIG,
  runChunkedExtraction,
  type SubCall,
  sweepStaleDumpDirs,
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

const EXTRACTION_DEFAULT_GOAL =
  "Extract the facts, names, dates, URLs, figures, and conclusions relevant to the user's research question."

/** Depth-1 RLM sub-call: an isolated, tool-less completion over the same
 * provider/model as the parent session. The raw document arrives inline; the
 * worker has no tools and no filesystem access, so crawled content cannot
 * trigger actions — it can only shape its own extraction. */
function makeSubCall(ctx: ExtensionContext, signal: AbortSignal | undefined): SubCall {
  return async (systemPrompt, userText) => {
    const model = ctx.model
    if (!model) throw new Error('no active model for the extraction sub-call')
    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() }],
      },
      // Output-bound sub-calls: hard cap keeps extraction latency bounded,
      // and reasoning is suppressed — sampled 4/4 JSON adherence only with
      // reasoningEffort minimal (un-suppressed reasoning starved the output
      // cap and truncated the contract mid-object).
      { signal, maxTokens: RLM_CONFIG.maxOutputTokens, reasoningEffort: 'minimal' },
    )
    if (response.stopReason === 'error' || response.errorMessage) {
      throw new Error(response.errorMessage ?? `sub-call stopReason ${response.stopReason}`)
    }
    const text = response.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('\n')
    return { text, usage: response.usage }
  }
}

function extendedParameters(tool: DiscoveredTool): TSchema {
  const base = (tool.inputSchema ?? ANY_OBJECT) as Record<string, unknown>
  const properties = (base.properties ?? {}) as Record<string, unknown>
  return {
    ...base,
    properties: {
      ...properties,
      extraction_goal: {
        type: 'string',
        description:
          'Optional. What to look for in the result. Oversized raw results are distilled by an isolated sub-model ' +
          'in its own context; only the extraction enters your context window.',
      },
    },
  } as unknown as TSchema
}

function buildToolDefinition(tool: DiscoveredTool, getDumpStore: () => DumpStore): ToolDefinition {
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
      const { extraction_goal, ...mcpArgs } = params as Record<string, unknown>
      // Defensive: the tool_call hook steers full_page away; this guarantees
      // you-search MCP calls are highlights even if one slips through.
      if (tool.name === 'you-search') delete (mcpArgs as Record<string, unknown>).extraction
      // Defensive pin: contents is markdown-only — html/metadata formats would
      // bloat the sub-call input, and our chunk sizing is calibrated to markdown.
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
        // text block) written for the ROOT — distilling it into the extraction
        // contract would eat the steering. Tiny + pre-structured: pass through.
        if (tool.name === 'you-search' && isEmptySearchResult(adapted.details)) return adapted
        const goal = typeof extraction_goal === 'string' && extraction_goal.trim() ? extraction_goal.trim() : undefined
        const shouldExtract = ctx.model && (goal !== undefined || rawText.length > RLM_CONFIG.minChars)
        if (!shouldExtract) return adapted

        const store = getDumpStore()
        const dump = await store.write(tool.name, rawText)
        onUpdate?.({
          content: [{ type: 'text', text: `[RLM] distilling ${rawText.length} chars in an isolated sub-call...` }],
          details: {},
        })
        try {
          // One sub-call per tool call wherever possible: single call when the
          // raw result fits one chunk; deterministic goal-narrowing to keep it
          // a single call for giants; bounded chunk+map only when narrowing
          // finds nothing.
          const goalEffective = goal ?? EXTRACTION_DEFAULT_GOAL
          let extractionInput = rawText
          let mode: 'single' | 'narrowed' | 'chunked' = 'single'
          let narrowedRegions: number | undefined
          if (rawText.length > RLM_CONFIG.chunkChars) {
            const narrowed = narrowToGoal(rawText, goalEffective, RLM_CONFIG.chunkChars)
            if (narrowed) {
              extractionInput = narrowed.text
              narrowedRegions = narrowed.matchedRegions
              mode = 'narrowed'
            } else {
              mode = 'chunked'
            }
          }
          const outcome = await runChunkedExtraction(
            makeSubCall(ctx, signal),
            extractionInput,
            goalEffective,
            RLM_CONFIG,
          )
          // Structured contract: JSON in, lean facts + gaps out. A parse
          // failure degrades to prose extraction (the pre-contract behavior);
          // it must never discard the result the call already paid for.
          const contract = parseExtractionContract(outcome.text)
          const extractedText = contract.ok ? formatStructuredExtraction(contract.contract) : outcome.text
          return {
            content: [
              {
                type: 'text',
                text: formatExtractionSuccess(rawText.length, outcome.chunks, extractedText, outcome.truncatedToChunks),
              },
            ],
            details: {
              ...(typeof adapted.details === 'object' && adapted.details !== null ? adapted.details : {}),
              rlm: {
                mode,
                contract: contract.ok ? 'json' : 'prose',
                goalStatus: contract.ok ? contract.contract.goal_status : undefined,
                facts: contract.ok ? contract.contract.facts.length : undefined,
                confidence: contract.ok ? contract.contract.confidence : undefined,
                unresolvedGaps: contract.ok ? contract.contract.unresolved_gaps : undefined,
                chunks: outcome.chunks,
                originalLength: rawText.length,
                extractedLength: extractedText.length,
                truncated: outcome.truncatedToChunks,
                narrowedRegions,
                dumpPath: dump.path,
              },
            },
            usage: outcome.usage,
          }
        } catch (error) {
          // Extraction failure must degrade to raw text (the budget-policy
          // truncation hook caps it), never to a tool error that discards
          // results the call already paid for.
          const message = error instanceof Error ? error.message : String(error)
          return {
            content: [{ type: 'text', text: formatExtractionFallback(rawText.length, message, rawText) }],
            details: { rlmError: message, dumpPath: dump.path },
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
  let dumpStore: DumpStore | undefined
  function getDumpStore(): DumpStore {
    dumpStore ??= new DumpStore()
    return dumpStore
  }

  const tools = await discoverTools()
  for (const tool of tools) pi.registerTool(buildToolDefinition(tool, getDumpStore))

  // Sweep crash residue (SIGKILL'd runs) from other pids; this process's dir
  // and fresh dirs from concurrent live runs are never touched.
  pi.on('session_start', () => {
    void sweepStaleDumpDirs()
  })

  // full_page steering: intercept BEFORE budget counting. The attempt is
  // blocked with the identify->extract note as the reason — it never leaves
  // the local loop (no MCP call, no sub-inference) and, like every block,
  // consumes no budget. See src/budget-policy.ts and src/rlm.ts.
  // Budget policy: hard cap (MAX_TOOL_CALLS, default 15) with an answer-forcing
  // block reason; one-time mid-budget check-in hint; per-result truncation
  // (MAX_TOOL_RESULT_CHARS, default 12000) so accumulated tool content cannot
  // push the model past its context window. RLM extraction runs on the raw
  // text before this hook; truncation remains the floor when extraction
  // fails. See src/budget-policy.ts and src/rlm.ts.
  const tracker = createBudgetTracker(readMaxToolCalls(process.env), readMaxToolResultChars(process.env))
  // Per-session deduper: exact-repeat queries are blocked budget-free with a
  // refine-or-answer note (the query-thrashing tier from the 2026-09-11 run).
  const queryDeduper = new QueryDeduper()
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
    void dumpStore?.cleanup()
    void closeSharedClient()
  })
}
