import { describe, expect, test } from 'bun:test'
import { buildCells, cellEnv, renderComparison } from '../scripts/ab-grid.ts'

describe('buildCells', () => {
  test('builds the 2x2 grid: cap 10/15 x thinking medium/high', () => {
    const cells = buildCells()
    expect(cells.map((c) => c.name)).toEqual(['cap10-med', 'cap10-high', 'cap15-med', 'cap15-high'])
    expect(cells[0]).toMatchObject({ maxToolCalls: '10', thinking: 'medium' })
    expect(cells[3]).toMatchObject({ maxToolCalls: '15', thinking: 'high' })
  })
})

describe('cellEnv', () => {
  test('isolates each cell artifact path and sets the knobs', () => {
    const env = cellEnv(
      { name: 'cap15-high', maxToolCalls: '15', thinking: 'high' },
      { model: 'meta/muse-glimmer-30b', limit: '50', k: '1', abDir: 'data/ab', baseEnv: {} },
    )
    expect(env.MODEL).toBe('meta/muse-glimmer-30b')
    expect(env.MAX_TOOL_CALLS).toBe('15')
    expect(env.THINKING_LEVEL).toBe('high')
    expect(env.LIMIT).toBe('50')
    expect(env.K).toBe('1')
    expect(env.FORCE).toBe('1')
    expect(env.TRAJECTORIES_PATH).toBe('data/ab/cap15-high-traj.jsonl')
    expect(env.GRADED_PATH).toBe('data/ab/cap15-high-graded.jsonl')
    expect(env.SUMMARY_PATH).toBe('data/ab/cap15-high-summary.json')
    expect(env.RESULTS_PATH).toBe('data/ab/cap15-high-results.jsonl')
    expect(env.LABEL).toBe('ab-cap15-high')
  })
})

describe('renderComparison', () => {
  test('renders one row per cell with headline metrics', () => {
    const out = renderComparison([
      { name: 'cap10-med', summary: { raw: { averageScore: 0.5, passRate: 0.4, exactPassAtK: 0.6, trialCount: 50 } } },
      { name: 'cap15-high', summary: null },
    ])
    expect(out).toContain('cap10-med')
    expect(out).toContain('0.5000')
    expect(out).toContain('cap15-high')
    expect(out).toContain('(no summary)')
  })
})
