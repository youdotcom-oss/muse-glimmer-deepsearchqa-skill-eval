import { describe, expect, test } from 'bun:test'
import { accountRun } from '../scripts/partner-probe.ts'

describe('accountRun', () => {
  test('sums per-call bytes and counts calls per tool', () => {
    const summary = accountRun([
      { tool: 'you-search', bytes: 100_000, query: 'q1' },
      { tool: 'you-search', bytes: 250_000, query: 'q2' },
      { tool: 'you-contents', bytes: 500_000, query: '' },
    ])
    expect(summary.calls).toBe(3)
    expect(summary.searchCalls).toBe(2)
    expect(summary.totalBytes).toBe(850_000)
    expect(summary.maxCallBytes).toBe(500_000)
  })

  test('handles empty runs', () => {
    const summary = accountRun([])
    expect(summary.calls).toBe(0)
    expect(summary.totalBytes).toBe(0)
    expect(summary.maxCallBytes).toBe(0)
  })
})
