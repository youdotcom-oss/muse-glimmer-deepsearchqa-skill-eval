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
  return Number.isFinite(value) && value >= 1 ? value : 10
}

export function readMaxToolResultChars(env: Record<string, string | undefined>): number {
  const value = Number.parseInt(env.MAX_TOOL_RESULT_CHARS ?? '', 10)
  return Number.isFinite(value) && value >= 100 ? value : 12_000
}

/** Mid-budget check-in: budget status + set-completion and answer-filter
 * guidance, placed on the midpoint call's result so it lands right before the
 * model drafts its answer (and before the cap for uncapped trials). */
export function buildCheckInHint(used: number, maxCalls: number): string {
  return (
    `\n\n---\n` +
    `BUDGET CHECK-IN: you are ${used}/${maxCalls} — halfway of your tool budget. ` +
    `If the question asks for a set, use your remaining budget to complete the enumeration ` +
    `(verify you have found every item). When you write your final answer, it must list ` +
    `ONLY the items that satisfy every criterion in the question — never the intermediate candidate set.`
  )
}

/** Cap-block reason: forces the final answer and forbids the candidate-set dump
 * (the P3 failure pattern: trials whose answers contain every correct item plus
 * 4+ extras score 0.58 instead of passing). */
export function buildBudgetExhaustedReason(maxCalls: number): string {
  return (
    `Tool budget exhausted (${maxCalls}/${maxCalls}). ` +
    'You have enough evidence to answer. Stop calling tools and write your final answer now. ' +
    'Your final answer must list ONLY the items that satisfy every criterion in the question — ' +
    'never the intermediate candidate set. If the question asks for a set, verify you have ' +
    'found every item, then answer.'
  )
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…[truncated: ${text.length - maxChars} chars omitted]`
}

export interface BudgetTracker {
  /** Returns the block result when the call exceeds the budget. */
  onToolCall(): { block: true; reason: string } | undefined
  /** Truncates oversized text blocks and, at the budget midpoint, appends the
   * check-in hint once. Returns the mutated content, or undefined when
   * unchanged. Non-text blocks pass through untouched. Generic so pi's own
   * TextContent/ImageContent types flow through unchanged. */
  onToolResult<T extends ContentBlock>(content: T[]): { content: T[] } | undefined
}

function isOversizedText(block: ContentBlock, maxChars: number): block is ContentBlock & { text: string } {
  return block.type === 'text' && typeof block.text === 'string' && block.text.length > maxChars
}

export function createBudgetTracker(maxCalls: number, maxResultChars: number): BudgetTracker {
  let callsUsed = 0
  let checkInPending = false
  const midpoint = Math.ceil(maxCalls / 2)
  return {
    onToolCall() {
      if (callsUsed >= maxCalls) return { block: true, reason: buildBudgetExhaustedReason(maxCalls) }
      callsUsed += 1
      if (callsUsed === midpoint) checkInPending = true
      return undefined
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
      return mutated ? { content: next } : undefined
    },
  }
}
