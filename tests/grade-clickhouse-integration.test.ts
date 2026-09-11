import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gradeWithClickhouse } from '../src/grade-clickhouse.ts'

const TMP = join(import.meta.dir, '.tmp-grade-integration')
const TRAJECTORIES = join(TMP, 'trajectories.jsonl')
const GRADED = join(TMP, 'graded.jsonl')
const SUMMARY = join(TMP, 'summary.json')
const CLICKHOUSE = join(import.meta.dir, '..', 'clickhouse') + ' local'
const GRADER_CMD = ['bun', 'run', 'src/grader.ts']
const JUDGE_MODEL = 'qwen/qwen3.6-flash'

// Two synthetic trial rows: one completed-with-answer, one failed.
// Keep them tiny so clickhouse reads them instantly. The shape matches the
// harness TrialResultRowSchema minimally; only the fields grading touches are
// populated. The completed row's task carries expected_answer metadata so the
// answer grader can grade without a real LLM call when the message matches.
const COMPLETED_ROW = {
  schemaVersion: 1,
  type: 'trial_result',
  harness: { name: '@plaited/agent-eval-harness', version: '1.0.1' },
  runId: 'test-run',
  label: 'test-model-you-web',
  taskId: 'deepsearchqa-0',
  trialIndex: 0,
  trialId: 'test-trial-0',
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
  trial: {
    id: 'test-trial-0',
    cwd: '/tmp',
    result: { status: 'completed', message: 'New Zealand', error: '', failureKind: '' },
    trajectory: [
      { type: 'message', role: 'user', content: 'Which country?' },
      { type: 'tool_call', name: 'you-search', status: 'completed' },
      { type: 'message', role: 'assistant', content: 'New Zealand' },
    ],
    invocation: { command: [], exitCode: 0, durationMs: 1000, startedAt: '', completedAt: '' },
    metadata: { source: 'google/deepsearchqa', model: 'test-model', provider: 'openrouter', thinkingLevel: 'medium' },
    task: {
      id: 'deepsearchqa-0',
      prompts: ['Which country?'],
      metadata: {
        source: 'google/deepsearchqa',
        expected_answer: 'New Zealand',
        answer_type: 'Single Answer',
        gradable: true,
      },
    },
  },
  process: null,
  graderResults: [],
  pass: null,
  score: null,
  reasoning: null,
  metadata: { source: 'google/deepsearchqa' },
}

const FAILED_ROW = {
  ...COMPLETED_ROW,
  taskId: 'deepsearchqa-1',
  trialIndex: 0,
  trialId: 'test-trial-1',
  trial: {
    ...COMPLETED_ROW.trial,
    result: {
      status: 'failed',
      message: '',
      error: 'Adapter exited with code 1.',
      failureKind: 'adapter_exit_nonzero',
    },
    task: { ...COMPLETED_ROW.trial.task, id: 'deepsearchqa-1' },
  },
}

describe('gradeWithClickhouse (integration)', () => {
  test('grades trajectories.jsonl into graded.jsonl + summary.json the existing readers accept', async () => {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(TRAJECTORIES, [COMPLETED_ROW, FAILED_ROW].map((r) => JSON.stringify(r)).join('\n') + '\n')

    const summary = await gradeWithClickhouse({
      trajectoriesPath: TRAJECTORIES,
      gradedPath: GRADED,
      summaryPath: SUMMARY,
      clickhouseCommand: CLICKHOUSE,
      answerGraderCommand: GRADER_CMD,
      answerGraderModel: JUDGE_MODEL,
      processOptions: { id: 'process', weight: 0.1, failOnFailedToolCalls: false },
      k: 1,
      model: 'test-model',
      skipAnswerGrader: !process.env.OPENROUTER_API_KEY,
    })

    expect(summary.model).toBe('test-model')
    expect(summary.k).toBe(1)
    expect(summary.raw.trialCount).toBe(2)
    expect(summary.raw.taskCount).toBe(2)
    expect(summary.process.totalToolCalls).toBeGreaterThanOrEqual(1)
  }, 30_000)

  test('clickhouse reads the file directly (no harness stdout write) — produces one graded row per trajectory', async () => {
    const rows = (await Bun.file(GRADED).text()).trim().split('\n').filter(Boolean)
    expect(rows.length).toBe(2)
    for (const row of rows) {
      const parsed = JSON.parse(row)
      expect(parsed.graderResults).toBeInstanceOf(Array)
      expect(parsed).toHaveProperty('pass')
      expect(parsed).toHaveProperty('score')
      expect(parsed).toHaveProperty('reasoning')
    }
  })

  test('cleans up', () => {
    rmSync(TMP, { recursive: true, force: true })
  })
})
