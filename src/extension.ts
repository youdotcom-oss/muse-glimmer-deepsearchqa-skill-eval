/** You.com MCP bridge for Pi: dash-cased `you-search` and `you-contents` with RLM-style
 * depth-1 extraction built in. Root-facing surface stays exactly the two pre-work tools;
 * all heavy-content machinery (deterministic goal grep, distillation sub-calls, the
 * sufficiency-gated stage-2 page reads) lives inside the tools. full_page attempts on
 * you-search are intercepted at the tool_call hook with a budget-free steering note.
 *
 * RLM v7 — two-stage sufficiency-gated distillation: the search sub-model judges
 * sufficiency relative to the overall task (the meta-query) and its own query; the
 * extension executes any nominated page reads as one internal you-contents fetch plus
 * parallel distill sub-calls; the root sees one result. */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { type CallToolResult, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type TSchema, Type } from 'typebox'
import { createBudgetTracker, readMaxToolCalls, readMaxToolResultChars, truncateText } from './budget-policy.ts'
import {
  addUsage,
  buildDefaultGoal,
  buildQueryRepeatNote,
  buildSearchDistillPrompt,
  buildTargetDistillPrompt,
  collateContracts,
  type ExtractionContract,
  type ExtractionTarget,
  type FetchedDocument,
  FULL_PAGE_STEERING_NOTE,
  formatExtractionFallback,
  formatExtractionSuccess,
  formatStructuredExtraction,
  GENERIC_EXTRACTION_GOAL,
  isEmptySearchResult,
  isFullPageSearch,
  narrowToGoal,
  parseContentsResponse,
  parseExtractionContract,
  QueryDeduper,
  RLM_CONFIG,
  type SubCall,
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
 * cannot trigger actions — it can only shape its own extraction. */
function makeSubCall(ctx: ExtensionContext, signal: AbortSignal | undefined): SubCall {
  return async (prompt) => {
    const model = ctx.model
    if (!model) throw new Error('no active model for the extraction sub-call')
    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
      },
      // Output-bound sub-calls: hard cap keeps extraction latency bounded.
      // v7 runs them at reasoningEffort medium — the sufficiency verdict and
      // target nomination are judgment calls over the task, not pure span
      // extraction (the v5 minimal setting suppressed reasoning to protect
      // the output cap; the cap below still bounds latency).
      { signal, maxTokens: RLM_CONFIG.maxOutputTokens, reasoningEffort: 'medium' },
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

/** The overall task for distill prompts: the session's research question (the
 * meta-query) when captured, else the explicit extraction goal, else the
 * generic extraction contract. */
function buildTask(researchQuestion: string | undefined, goal: string | undefined): string {
  if (researchQuestion && researchQuestion.trim().length > 0) return researchQuestion
  return goal ?? GENERIC_EXTRACTION_GOAL
}

function buildToolDefinition(tool: DiscoveredTool, getResearchQuestion: () => string | undefined): ToolDefinition {
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
        // text block) written for the ROOT — distilling it into the extraction
        // contract would eat the steering. Tiny + pre-structured: pass through.
        if (tool.name === 'you-search' && isEmptySearchResult(adapted.details)) return adapted
        const goal = typeof extraction_goal === 'string' && extraction_goal.trim() ? extraction_goal.trim() : undefined
        if (!ctx.model) return adapted

        onUpdate?.({
          content: [{ type: 'text', text: `[RLM] distilling ${rawText.length} chars in isolated sub-call(s)...` }],
          details: {},
        })
        try {
          const researchQuestion = getResearchQuestion()
          const task = buildTask(researchQuestion, goal)
          const goalEffective = goal ?? buildDefaultGoal(researchQuestion)
          const subCall = makeSubCall(ctx, signal)
          const adaptedDetails = typeof adapted.details === 'object' && adapted.details !== null ? adapted.details : {}

          if (tool.name === 'you-search') {
            // ---- Stage 1: search distillation with a sufficiency verdict. ----
            const query = typeof mcpArgs.query === 'string' ? (mcpArgs.query as string) : ''
            const usage = zeroUsage()
            const stage1 = await subCall(buildSearchDistillPrompt({ task, query, rawResults: rawText }))
            addUsage(usage, stage1.usage)
            const contract = parseExtractionContract(stage1.text)
            if (!contract.ok) {
              // Prose fallback: never discard the paid-for search. Raw text,
              // truncated to the budget-policy per-result cap (the tool_result
              // hook would apply the same ceiling later anyway).
              const text = truncateText(rawText, readMaxToolResultChars(process.env))
              return {
                content: [{ type: 'text', text: formatExtractionFallback(rawText.length, 'no JSON contract', text) }],
                details: {
                  ...adaptedDetails,
                  rlm: { contract: 'prose', originalLength: rawText.length, internalContentsCalls: 0 },
                },
                usage,
              }
            }
            const c = contract.contract
            const targets = c.targets ?? []

            // ---- Stage 2: gated contents exploration (deterministic). ----
            let targetDocs: { target: ExtractionTarget; doc: string }[] = []
            if (c.sufficient === false && targets.length > 0) {
              onUpdate?.({
                content: [
                  {
                    type: 'text',
                    text: `[RLM] snippets insufficient for the task — reading ${targets.length} page(s) inside the tool call...`,
                  },
                ],
                details: {},
              })
              const urls = targets.map((t) => t.url)
              let docs: FetchedDocument[] = []
              try {
                // Internal fetch: no new tool_call event — one you-contents
                // call for all nominated URLs (≤3, validated by the parser).
                const contentsResult = await callTool('you-contents', { urls: [...urls], formats: ['markdown'] })
                if (!contentsResult.isError) {
                  const contentsAdapted = toToolResult(contentsResult)
                  docs = parseContentsResponse(
                    contentsAdapted.details,
                    contentsAdapted.content.map((block) => block.text).join('\n'),
                  )
                }
              } catch {
                // Best-effort: the stage-1 result stands below.
              }
              targetDocs = targets
                .map((t) => ({ target: t, doc: docs.find((d) => d.url === t.url)?.markdown }))
                .filter((pair): pair is { target: ExtractionTarget; doc: string } => typeof pair.doc === 'string')
            }

            if (targetDocs.length === 0) {
              // Sufficient verdict, no usable targets, or fetch errored/empty:
              // the stage-1 result is the result (never discard the paid read).
              const extractedText = formatStructuredExtraction(c)
              return {
                content: [{ type: 'text', text: formatExtractionSuccess(rawText.length, 1, extractedText, false) }],
                details: {
                  ...adaptedDetails,
                  rlm: {
                    mode: 'single',
                    contract: 'json',
                    goalStatus: c.goal_status,
                    facts: c.facts.length,
                    confidence: c.confidence,
                    unresolvedGaps: c.unresolved_gaps,
                    suggestion: c.suggestion,
                    originalLength: rawText.length,
                    extractedLength: extractedText.length,
                    internalContentsCalls: 0,
                  },
                },
                usage,
              }
            }

            // One distill sub-call per fetched document, parallel, shared task.
            const stage2Outputs = await Promise.all(
              targetDocs.map(({ target, doc }) => {
                let input = doc
                if (input.length > RLM_CONFIG.chunkChars) {
                  const narrowed = narrowToGoal(input, goalEffective, RLM_CONFIG.chunkChars)
                  input = narrowed ? narrowed.text : input.slice(0, RLM_CONFIG.chunkChars)
                }
                return subCall(buildTargetDistillPrompt({ task, query, guidance: target.extract, doc: input }))
              }),
            )
            const stage2Contracts: ExtractionContract[] = []
            for (const output of stage2Outputs) {
              addUsage(usage, output.usage)
              const parsed = parseExtractionContract(output.text)
              if (parsed.ok) stage2Contracts.push(parsed.contract)
            }
            const collated = collateContracts(c, stage2Contracts)
            const extractedText = formatStructuredExtraction(collated)
            return {
              content: [
                {
                  type: 'text',
                  text: formatExtractionSuccess(rawText.length, 1 + stage2Contracts.length, extractedText, false),
                },
              ],
              details: {
                ...adaptedDetails,
                rlm: {
                  mode: 'two-stage',
                  contract: 'json',
                  goalStatus: collated.goal_status,
                  facts: collated.facts.length,
                  confidence: collated.confidence,
                  unresolvedGaps: collated.unresolved_gaps,
                  suggestion: collated.suggestion,
                  originalLength: rawText.length,
                  extractedLength: extractedText.length,
                  stage2: {
                    urls: targetDocs.map((pair) => pair.target.url),
                    facts: stage2Contracts.reduce((n, p) => n + p.facts.length, 0),
                  },
                  internalContentsCalls: 1,
                },
              },
              usage,
            }
          }

          // ---- you-contents: single-stage distillation (direct read). ----
          if (goal === undefined && rawText.length <= RLM_CONFIG.minChars) return adapted
          let extractionInput = rawText
          let mode: 'single' | 'narrowed' = 'single'
          let inputTruncated = false
          if (rawText.length > RLM_CONFIG.chunkChars) {
            const narrowed = narrowToGoal(rawText, goalEffective, RLM_CONFIG.chunkChars)
            if (narrowed) {
              extractionInput = narrowed.text
              mode = 'narrowed'
            } else {
              extractionInput = rawText.slice(0, RLM_CONFIG.chunkChars)
              inputTruncated = true
            }
          }
          const outcome = await subCall(
            buildTargetDistillPrompt({ task, query: '', guidance: goalEffective, doc: extractionInput }),
          )
          const contract = parseExtractionContract(outcome.text)
          const usage = addUsage(zeroUsage(), outcome.usage)
          const extractedText = contract.ok ? formatStructuredExtraction(contract.contract) : outcome.text
          return {
            content: [
              { type: 'text', text: formatExtractionSuccess(rawText.length, 1, extractedText, inputTruncated) },
            ],
            details: {
              ...adaptedDetails,
              rlm: {
                mode,
                contract: contract.ok ? 'json' : 'prose',
                goalStatus: contract.ok ? contract.contract.goal_status : undefined,
                facts: contract.ok ? contract.contract.facts.length : undefined,
                confidence: contract.ok ? contract.contract.confidence : undefined,
                unresolvedGaps: contract.ok ? contract.contract.unresolved_gaps : undefined,
                suggestion: contract.ok ? contract.contract.suggestion : undefined,
                originalLength: rawText.length,
                extractedLength: extractedText.length,
                truncated: inputTruncated,
                internalContentsCalls: 0,
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
  // the sub-model can filter facts for relevance (the blind-goal default made
  // sub-model gaps literally ask for the question). First prompt wins; the
  // eval sends exactly one.
  let researchQuestion: string | undefined
  pi.on('before_agent_start', (event) => {
    researchQuestion ??= event.prompt
  })

  const tools = await discoverTools()
  for (const tool of tools) pi.registerTool(buildToolDefinition(tool, () => researchQuestion))

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
    void closeSharedClient()
  })
}
