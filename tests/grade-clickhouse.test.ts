import { describe, expect, test } from 'bun:test'
import type { GraderResult, TrialRow } from '../src/grade-clickhouse.ts'
import { computeOverall, gradeProcess, projectForAnswerGrader } from '../src/grade-clickhouse.ts'

// A minimal completed trial: no errors, no failed tool calls.
const completedTrial: TrialRow = {
  trial: {
    result: { status: 'completed', message: 'New Zealand', error: '', failureKind: '' },
    invocation: { exitCode: 0, durationMs: 1000, startedAt: '', completedAt: '' },
    trajectory: [
      { type: 'message', role: 'user', content: '' },
      { type: 'tool_call', name: 'you-search', status: 'completed' },
      { type: 'tool_call', name: 'you-search', status: 'completed' },
    ],
    metadata: {},
  },
} as unknown as TrialRow

// A failed trial: adapter exited non-zero, one error event, one failed tool call.
const failedTrial: TrialRow = {
  trial: {
    result: { status: 'failed', message: '', error: 'boom', failureKind: 'adapter_exit_nonzero' },
    invocation: { exitCode: 1, durationMs: 100, startedAt: '', completedAt: '' },
    trajectory: [
      { type: 'tool_call', name: 'you-search', status: 'failed' },
      { type: 'error', message: 'kaboom' },
    ],
    metadata: {},
  },
} as unknown as TrialRow

describe('gradeProcess', () => {
  test('passes a completed trial with no errors or failed tool calls', () => {
    const result = gradeProcess(completedTrial, { id: 'process', weight: 0.1 })
    expect(result.id).toBe('process')
    expect(result.type).toBe('process')
    expect(result.required).toBe(true)
    expect(result.weight).toBe(0.1)
    expect(result.skipped).toBe(false)
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1)
    expect(result.reasoning).toBe('Process checks passed.')
  })

  test('fails a non-completed trial with status in the reasoning', () => {
    const result = gradeProcess(failedTrial, { id: 'process', weight: 0.1 })
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0)
    expect(result.reasoning).toContain('status=failed')
    expect(result.reasoning).toContain('error events detected')
    expect(result.reasoning).toContain('failed tool_call events detected')
  })

  test('does not fail on failed tool calls when failOnFailedToolCalls is false', () => {
    // A completed trial that nonetheless has blocked (failed) tool calls — the
    // budget-cap case where blocks are expected, not a process malfunction.
    const row: TrialRow = {
      trial: {
        result: { status: 'completed', message: 'New Zealand', error: '', failureKind: '' },
        invocation: { exitCode: 0, durationMs: 1000, startedAt: '', completedAt: '' },
        trajectory: [
          { type: 'tool_call', name: 'you-search', status: 'completed' },
          { type: 'tool_call', name: 'you-search', status: 'failed' },
        ],
        metadata: {},
      },
    } as unknown as TrialRow
    const result = gradeProcess(row, { id: 'process', weight: 0.1, failOnFailedToolCalls: false })
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1)
  })
})

describe('projectForAnswerGrader', () => {
  test('keeps only the fields the answer grader reads, dropping trajectory and stdout', () => {
    const full: TrialRow = {
      trial: {
        result: { status: 'completed', message: 'New Zealand', error: '', failureKind: '' },
        invocation: { exitCode: 0, durationMs: 1000, startedAt: '', completedAt: '' },
        trajectory: [
          { type: 'tool_call', name: 'you-search', status: 'completed' },
          // imagine this event's output is 16MB — it must not appear in the projection
          { type: 'tool_call', name: 'you-contents', status: 'completed' },
        ],
        metadata: { usage: { totalTokens: 97014 } },
        cwd: '/x',
        id: 'trial-1',
        task: {
          prompts: ['What country?'],
          metadata: { expected_answer: 'New Zealand', answer_type: 'Single Answer', gradable: true },
        } as unknown as TrialRow['trial'] extends { task: infer T } ? T : never,
      },
    } as unknown as TrialRow
    const projected = projectForAnswerGrader(full)
    // The answer grader reads exactly these paths:
    expect(projected.trial.task.prompts).toEqual(['What country?'])
    expect(projected.trial.task.metadata).toMatchObject({ expected_answer: 'New Zealand' })
    expect(projected.trial.result.message).toBe('New Zealand')
    expect(projected.trial.result.status).toBe('completed')
    // The heavy fields must be gone:
    expect('trajectory' in projected.trial).toBe(false)
    expect('invocation' in projected.trial).toBe(false)
  })
})

describe('computeOverall', () => {
  const passProcess: GraderResult = {
    id: 'process',
    type: 'process',
    required: true,
    weight: 0.1,
    skipped: false,
    pass: true,
    score: 1,
    reasoning: 'Process checks passed.',
  }
  const passAnswer: GraderResult = {
    id: 'deepsearchqa-answer',
    type: 'command',
    required: true,
    weight: 1,
    skipped: false,
    pass: true,
    score: 1,
    reasoning: 'exact match',
  }

  test('passes with weighted score when all required graders pass', () => {
    const row = {
      trial: { result: { status: 'completed' } },
      graderResults: [passProcess, passAnswer],
    } as unknown as TrialRow
    const overall = computeOverall(row)
    expect(overall.pass).toBe(true)
    expect(overall.score).toBeCloseTo(1, 8)
    expect(overall.reasoning).toBe('All required graders passed.')
  })

  test('forces pass=false and score=0 for a non-completed trial', () => {
    const row = {
      trial: { result: { status: 'failed' } },
      graderResults: [passProcess, passAnswer],
    } as unknown as TrialRow
    const overall = computeOverall(row)
    expect(overall.pass).toBe(false)
    expect(overall.score).toBe(0)
    expect(overall.reasoning).toContain("Trial status 'failed' forces")
  })

  test('fails when a required grader fails even if another scores well', () => {
    const failProcess: GraderResult = { ...passProcess, pass: false, score: 0, reasoning: 'status=failed' }
    const row = {
      trial: { result: { status: 'completed' } },
      graderResults: [failProcess, passAnswer],
    } as unknown as TrialRow
    const overall = computeOverall(row)
    expect(overall.pass).toBe(false)
    // weighted: (0*0.1 + 1*1) / (0.1+1) ≈ 0.909
    expect(overall.score).toBeCloseTo(0.909, 3)
    expect(overall.reasoning).toBe('At least one required grader failed.')
  })
})
