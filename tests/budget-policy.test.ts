import { describe, expect, test } from 'bun:test'
import {
  buildBudgetExhaustedReason,
  buildCheckInHint,
  type ContentBlock,
  createBudgetTracker,
  readMaxToolCalls,
  readMaxToolResultChars,
} from '../src/budget-policy.ts'

const textOf = (b: ContentBlock): string => String(b.text ?? '')

describe('readMaxToolCalls', () => {
  test('reads MAX_TOOL_CALLS from env, defaults to 10, rejects invalid', () => {
    expect(readMaxToolCalls({ MAX_TOOL_CALLS: '15' })).toBe(15)
    expect(readMaxToolCalls({})).toBe(10)
    expect(readMaxToolCalls({ MAX_TOOL_CALLS: 'zero' })).toBe(10)
    expect(readMaxToolCalls({ MAX_TOOL_CALLS: '0' })).toBe(10)
  })
})

describe('readMaxToolResultChars', () => {
  test('reads MAX_TOOL_RESULT_CHARS from env, defaults to 12000', () => {
    expect(readMaxToolResultChars({ MAX_TOOL_RESULT_CHARS: '5000' })).toBe(5000)
    expect(readMaxToolResultChars({})).toBe(12_000)
  })
})

describe('createBudgetTracker.onToolCall', () => {
  test('allows calls up to the cap, then blocks with the P3-filter reason', () => {
    const tracker = createBudgetTracker(3, 12_000)
    expect(tracker.onToolCall()).toBeUndefined()
    expect(tracker.onToolCall()).toBeUndefined()
    expect(tracker.onToolCall()).toBeUndefined()
    const blocked = tracker.onToolCall()
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('Tool budget exhausted (3/3)')
    expect(blocked?.reason).toContain('ONLY the items that satisfy every criterion')
  })

  test('blocked calls do not consume budget further', () => {
    const tracker = createBudgetTracker(1, 12_000)
    expect(tracker.onToolCall()).toBeUndefined()
    expect(tracker.onToolCall()?.block).toBe(true)
    expect(tracker.onToolCall()?.block).toBe(true)
  })
})

describe('createBudgetTracker.onToolResult', () => {
  test('fires the mid-budget check-in exactly once, on the midpoint result', () => {
    const tracker = createBudgetTracker(4, 12_000)
    // midpoint = ceil(4/2) = 2: the check-in rides the 2nd call's result.
    tracker.onToolCall()
    const r1 = tracker.onToolResult([{ type: 'text', text: 'a' }])
    expect(r1?.content.some((b) => textOf(b).includes('halfway')) ?? false).toBe(false)
    tracker.onToolCall()
    const r2 = tracker.onToolResult([{ type: 'text', text: 'b' }])
    expect(r2?.content.some((b) => textOf(b).includes('you are 2/4') && textOf(b).includes('halfway'))).toBe(true)
    expect(r2?.content.some((b) => textOf(b).includes('ONLY the items that satisfy every criterion'))).toBe(true)
    // Fires once only.
    tracker.onToolCall()
    const r3 = tracker.onToolResult([{ type: 'text', text: 'c' }])
    expect(r3?.content.some((b) => textOf(b).includes('halfway')) ?? false).toBe(false)
  })

  test('truncates oversized result blocks with an omission marker', () => {
    const tracker = createBudgetTracker(10, 100)
    const big = 'x'.repeat(300)
    const r = tracker.onToolResult([{ type: 'text', text: big }])
    const text = String(r?.content[0]?.text ?? '')
    expect(text.length).toBeLessThanOrEqual(100 + 100) // cap + marker headroom
    expect(text).toContain('truncated')
    expect(text).toContain('200 chars omitted')
  })

  test('leaves small results unchanged (returns undefined)', () => {
    const tracker = createBudgetTracker(10, 1_000)
    expect(tracker.onToolResult([{ type: 'text', text: 'small' }])).toBeUndefined()
  })

  test('passes non-text blocks through untouched', () => {
    const tracker = createBudgetTracker(2, 1_000)
    tracker.onToolCall()
    // midpoint = 1: hint fires on this result, image block must survive.
    const r = tracker.onToolResult([
      { type: 'image', data: 'base64' },
      { type: 'text', text: 'caption' },
    ])
    expect(r?.content[0]?.type).toBe('image')
    expect(r?.content[0]?.data).toBe('base64')
    expect(r?.content.some((b) => b.type === 'text' && String(b.text).includes('halfway'))).toBe(true)
  })
})

describe('hint builders', () => {
  test('check-in mentions budget state, set completion, and answer filtering', () => {
    const hint = buildCheckInHint(5, 10)
    expect(hint).toContain('you are 5/10')
    expect(hint).toContain('halfway of your tool budget')
    expect(hint).toContain('ONLY the items that satisfy every criterion')
    expect(hint).toContain('complete the enumeration')
  })

  test('exhausted reason forces the final answer and forbids the candidate dump', () => {
    const reason = buildBudgetExhaustedReason(10)
    expect(reason).toContain('Tool budget exhausted (10/10)')
    expect(reason).toContain('final answer')
    expect(reason).toContain('never the intermediate candidate set')
  })
})
