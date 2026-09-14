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
  test('reads MAX_TOOL_CALLS from env, defaults to 15, rejects invalid', () => {
    expect(readMaxToolCalls({ MAX_TOOL_CALLS: '10' })).toBe(10)
    expect(readMaxToolCalls({})).toBe(15)
    expect(readMaxToolCalls({ MAX_TOOL_CALLS: 'zero' })).toBe(15)
    expect(readMaxToolCalls({ MAX_TOOL_CALLS: '0' })).toBe(15)
  })
})

describe('readMaxToolResultChars', () => {
  test('reads MAX_TOOL_RESULT_CHARS from env, defaults to 12000', () => {
    expect(readMaxToolResultChars({ MAX_TOOL_RESULT_CHARS: '5000' })).toBe(5000)
    expect(readMaxToolResultChars({})).toBe(12_000)
  })
})

describe('dump-tool side budget', () => {
  test('read-dump/grep-dump do not consume the search budget and get their own smaller cap', () => {
    const tracker = createBudgetTracker(3, 12_000)
    for (const name of ['read-dump', 'grep-dump', 'read-dump', 'grep-dump', 'read-dump', 'grep-dump']) {
      expect(tracker.onToolCall(name)).toBeUndefined()
    }
    // Search budget untouched by the six inspection calls: 3 base + 4 grace.
    for (let i = 0; i < 7; i += 1) expect(tracker.onToolCall('you-search')).toBeUndefined()
    expect(tracker.onToolCall('you-search')?.block).toBe(true)
    // Dump side budget now exhausted.
    const blocked = tracker.onToolCall('read-dump')
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('Inspection budget exhausted (6/6)')
    expect(blocked?.reason).toContain('final answer')
  })

  test('blocked dump calls do not consume further; dump cap defaults to 6', () => {
    const tracker = createBudgetTracker(15, 12_000)
    for (let i = 0; i < 6; i += 1) expect(tracker.onToolCall('grep-dump')).toBeUndefined()
    expect(tracker.onToolCall('grep-dump')?.block).toBe(true)
    expect(tracker.onToolCall('read-dump')?.block).toBe(true)
  })
})

describe('createBudgetTracker.onToolCall', () => {
  test('base budget, then a grace window of 4 gap-directed calls, then hard block', () => {
    const tracker = createBudgetTracker(3, 12_000)
    // Base budget: 3 calls.
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    // Grace window: 4 more gap-directed calls are allowed.
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    // Then the hard block, with the P3-filter answer-forcing reason.
    const blocked = tracker.onToolCall('you-search')
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('Tool budget exhausted (3/3)')
    expect(blocked?.reason).toContain('ONLY the items that satisfy every criterion')
  })

  test('blocked calls do not consume budget or grace further', () => {
    const tracker = createBudgetTracker(1, 12_000)
    expect(tracker.onToolCall('you-search')).toBeUndefined() // base 1
    expect(tracker.onToolCall('you-search')).toBeUndefined() // grace 1
    expect(tracker.onToolCall('you-search')).toBeUndefined() // grace 2
    expect(tracker.onToolCall('you-search')).toBeUndefined() // grace 3
    expect(tracker.onToolCall('you-search')).toBeUndefined() // grace 4
    expect(tracker.onToolCall('you-search')?.block).toBe(true)
    expect(tracker.onToolCall('you-search')?.block).toBe(true)
  })
})

describe('createBudgetTracker.onToolResult', () => {
  test('fires the mid-budget check-in exactly once, on the midpoint result', () => {
    const tracker = createBudgetTracker(4, 12_000)
    // midpoint = ceil(4/2) = 2: the check-in rides the 2nd call's result.
    tracker.onToolCall('you-search')
    const r1 = tracker.onToolResult([{ type: 'text', text: 'a' }])
    expect(r1?.content.some((b) => textOf(b).includes('halfway')) ?? false).toBe(false)
    tracker.onToolCall('you-search')
    const r2 = tracker.onToolResult([{ type: 'text', text: 'b' }])
    expect(r2?.content.some((b) => textOf(b).includes('you are 2/4') && textOf(b).includes('halfway'))).toBe(true)
    expect(r2?.content.some((b) => textOf(b).includes('ONLY the items that satisfy every criterion'))).toBe(true)
    // Fires once only.
    tracker.onToolCall('you-search')
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

  test('grace hint rides the first grace call result, exactly once, gap-directed', () => {
    const tracker = createBudgetTracker(2, 12_000)
    tracker.onToolCall('you-search')
    tracker.onToolCall('you-search')
    // Base-budget results carry no extension note.
    for (const text of ['a', 'b']) {
      expect(
        tracker
          .onToolResult([{ type: 'text', text }])
          ?.content.some((b) => String(b.text).includes('BUDGET EXTENSION')) ?? false,
      ).toBe(false)
    }
    // First grace call: allowed, and its result carries the gap-directed note.
    expect(tracker.onToolCall('you-search')).toBeUndefined()
    const r = tracker.onToolResult([{ type: 'text', text: 'grace result' }])
    const grace = r?.content.find((b) => String(b.text).includes('BUDGET EXTENSION'))
    expect(grace).toBeDefined()
    expect(String(grace?.text)).toContain('4 additional')
    expect(String(grace?.text)).toContain('unresolved gaps')
    expect(String(grace?.text)).toContain('you-contents')
    // Fires once only.
    expect(
      tracker
        .onToolResult([{ type: 'text', text: 'later' }])
        ?.content.some((b) => String(b.text).includes('BUDGET EXTENSION')) ?? false,
    ).toBe(false)
  })

  test('passes non-text blocks through untouched', () => {
    const tracker = createBudgetTracker(2, 1_000)
    tracker.onToolCall('you-search')
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
