/**
 * Budget policy for the You.com MCP extension: hard tool-call cap with an
 * answer-forcing block reason, a one-time mid-budget check-in hint appended to
 * the midpoint tool result, and per-result text truncation so accumulated tool
 * content cannot push the model past its context window (the second-order
 * overflow tier from the 2026-09-11 run: trials with 114k+ input tokens).
 *
 * Pure, unit-tested logic; src/extension.ts wires it into pi tool_call and
 * tool_result hooks.
 */

export interface TextBlock {
  type: 'text'
  text: string
}

/** Structural shape pi content blocks satisfy (text, image, …). Only text
 * blocks are truncated or receive hints; other block types pass through. */
export interface ContentBlock {
  type: string
  text?: unknown
}

export function readMaxToolCalls(env: Record<string, string | undefined>): number {
  const value = Number.parseInt(env.MAX_TOOL_CALLS ?? '', 10)
  // Default 15: the A/B grid (data/ab, 2026-09-11) showed the higher cap converts
  // incomplete-set failures now that the maxTokens 400 and overflow tiers are
  // fixed. Override with MAX_TOOL_CALLS=10 to reproduce the original cap.
  return Number.isFinite(value) && value >= 1 ? value : 15
}

export function readMaxToolResultChars(env: Record<string, string | undefined>): number {
  const value = Number.parseInt(env.MAX_TOOL_RESULT_CHARS ?? '', 10)
  return Number.isFinite(value) && value >= 100 ? value : 12_000
}

/** Mid-budget check-in: budget status + completeness and answer-filter
 * guidance, placed on the midpoint call's result so it lands right before the
 * model drafts its answer (and before the cap for uncapped trials). */
export function buildCheckInHint(used: number, maxCalls: number): string {
  return (
    `\n\n---\n` +
    `BUDGET CHECK-IN: you are ${used}/${maxCalls} — halfway of your tool budget. ` +
    `If the question asks for a complete list, use your remaining budget to verify you have found every item. ` +
    `When you write your final answer, include only what the question asks for — not your intermediate notes.`
  )
}

/** Cap-block reason: forces the final answer with answer-hygiene guidance. */
export function buildBudgetExhaustedReason(maxCalls: number): string {
  return (
    `Tool budget exhausted (${maxCalls}/${maxCalls}). ` +
    'You have enough evidence to answer. Stop calling tools and write your final answer now. ' +
    'Answer with only what the question asks for — no sources, commentary, or intermediate notes ' +
    'unless the question requests them.'
  )
}

/** Grace window: after the base budget is spent, this many additional calls
 * are allowed, directed at closing the unresolved gaps the extraction
 * sub-calls surfaced (the F3 failure pattern: trials answering with open gaps
 * despite 13 consecutive gap reports). Guidance rides the first grace call's
 * result; the hard cap follows. */
export const GRACE_TOOL_CALLS = 4

export function buildGraceHint(maxCalls: number, graceCalls: number): string {
  return (
    `\n\n---\nBUDGET EXTENSION: your base ${maxCalls} calls are spent. You have up to ${graceCalls} additional ` +
    'calls, ONLY to fill the unresolved gaps your extractions flagged — refine a query toward a named gap, ' +
    'or use you-contents on the most promising URL (highlights often lack tabular data). ' +
    'Then answer with the best-supported facts.'
  )
}

/** Dump-inspection tools (read-dump/grep-dump) ride on a small side budget
 * instead of the search cap: they are the re-inspection fallback for RLM
 * extraction, and taxing them against the A/B-validated search budget would
 * convert re-inspection needs into incomplete-set failures. 6 calls is ample
 * headroom for the grep -> read -> read pattern while bounding a loop. */
export const DUMP_TOOL_CALL_LIMIT = 6
const DUMP_TOOLS = new Set(['read-dump', 'grep-dump'])

export function buildDumpBudgetExhaustedReason(limit: number): string {
  return (
    `Inspection budget exhausted (${limit}/${limit}). ` +
    'Stop re-reading dump files and write your final answer now with the evidence you have.'
  )
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…[truncated: ${text.length - maxChars} chars omitted]`
}

export interface BudgetTracker {
  /** Returns the block result when the call exceeds its budget: the main cap
   * for search tools, the small side cap for dump-inspection tools. */
  onToolCall(toolName: string): { block: true; reason: string } | undefined
  /** Truncates oversized text blocks and, at the budget midpoint, appends the
   * check-in hint once. Returns the mutated content, or undefined when
   * unchanged. Non-text blocks pass through untouched. Generic so pi's own
   * TextContent/ImageContent types flow through unchanged. */
  onToolResult<T extends ContentBlock>(content: T[]): { content: T[] } | undefined
}

function isOversizedText(block: ContentBlock, maxChars: number): block is ContentBlock & { text: string } {
  return block.type === 'text' && typeof block.text === 'string' && block.text.length > maxChars
}

export function createBudgetTracker(
  maxCalls: number,
  maxResultChars: number,
  dumpLimit: number = DUMP_TOOL_CALL_LIMIT,
  graceLimit: number = GRACE_TOOL_CALLS,
): BudgetTracker {
  let callsUsed = 0
  let dumpCallsUsed = 0
  let graceUsed = 0
  let checkInPending = false
  let graceHintPending = false
  const midpoint = Math.ceil(maxCalls / 2)
  return {
    onToolCall(toolName: string) {
      if (DUMP_TOOLS.has(toolName)) {
        if (dumpCallsUsed >= dumpLimit) return { block: true, reason: buildDumpBudgetExhaustedReason(dumpLimit) }
        dumpCallsUsed += 1
        return undefined
      }
      if (callsUsed < maxCalls) {
        callsUsed += 1
        if (callsUsed === midpoint) checkInPending = true
        return undefined
      }
      // Grace window: gap-directed extension before the hard block.
      if (graceUsed < graceLimit) {
        if (graceUsed === 0) graceHintPending = true
        graceUsed += 1
        return undefined
      }
      return { block: true, reason: buildBudgetExhaustedReason(maxCalls) }
    },
    onToolResult(content) {
      let mutated = false
      let next = content
      if (content.some((block) => isOversizedText(block, maxResultChars))) {
        next = next.map((block) =>
          isOversizedText(block, maxResultChars)
            ? ({ ...block, text: truncateText(block.text, maxResultChars) } as typeof block)
            : block,
        )
        mutated = true
      }
      if (checkInPending) {
        checkInPending = false
        const hint = buildCheckInHint(callsUsed, maxCalls)
        let lastTextIndex = -1
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (next[i]?.type === 'text') {
            lastTextIndex = i
            break
          }
        }
        if (lastTextIndex === -1) {
          next = [...next, { type: 'text', text: hint } as (typeof next)[number]]
        } else {
          const last = next[lastTextIndex] as ContentBlock & { type: string; text: string }
          next = [
            ...next.slice(0, lastTextIndex),
            { ...last, text: last.text + hint } as (typeof next)[number],
            ...next.slice(lastTextIndex + 1),
          ]
        }
        mutated = true
      }
      if (graceHintPending) {
        graceHintPending = false
        const hint = buildGraceHint(maxCalls, graceLimit)
        next = [...next, { type: 'text', text: hint } as (typeof next)[number]]
        mutated = true
      }
      return mutated ? { content: next } : undefined
    },
  }
}
