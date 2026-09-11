/**
 * ClickHouse-based grading: replicates the harness's `process` rubric and
 * `computeOverall` as pure functions, so grading can read `trajectories.jsonl`
 * directly via clickhouse-local without the harness's single stdout write of a
 * ~25MB serialized row (which truncates and kills the harness on huge trials).
 *
 * The `deepsearchqa-answer` rubric (LLM judge) stays a subprocess fed a minimal
 * projection — see gradeWithClickhouse.
 */

export interface ProcessOptions {
  id: string
  weight?: number
  required?: boolean
  /** Defaults mirror the harness ProcessGraderDefinitionSchema (all true). */
  failOnNonCompletedStatus?: boolean
  failOnErrorEvents?: boolean
  failOnFailedOrTimedOutCommands?: boolean
  failOnFailedToolCalls?: boolean
  maxToolCalls?: number
  maxCommands?: number
  maxRepeatedToolCallNameCount?: number
}

export interface ProcessSummary {
  eventCount: number
  messageCount: number
  toolCallCount: number
  commandCount: number
  errorCount: number
  failedToolCallCount: number
  failedCommandCount: number
  timedOutCommandCount: number
  adapterTimedOut: boolean
  adapterExitCodeNonZero: boolean
  runtimeErrorDetected: boolean
  workerFailureDetected: boolean
  repeatedToolCallCount: number
  maxRepeatedToolCallNameCount: number
}

export interface GraderResult {
  id: string
  type: 'process' | 'command' | 'json'
  required: boolean
  weight: number
  skipped: boolean
  pass: boolean | null
  score: number | null
  reasoning: string | null
  outcome?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

// MINIMAL: TrialRow is the slice of the harness schema that grading touches.
// The full TrialResultRowSchema lives in @plaited/agent-eval-harness; we only
// need trial.trajectory/result/invocation/metadata and the process/graderResults
// fields. Upgrade path: import the zod schema if parity drifts.
export interface TrialRow {
  trial: {
    result: { status: 'completed' | 'failed' | 'timed_out' | 'cancelled'; message?: string; failureKind?: string }
    invocation: { exitCode: number | null; durationMs: number; startedAt: string; completedAt: string }
    trajectory: Array<{ type: string; name?: string; status?: string }>
    metadata?: Record<string, unknown>
    cwd?: string
    id?: string
  }
  process?: ProcessSummary
  graderResults?: GraderResult[]
}

export function computeProcessSummary(trial: TrialRow['trial']): ProcessSummary {
  const events = trial.trajectory
  const messageCount = events.filter((e) => e.type === 'message').length
  const toolCalls = events.filter((e) => e.type === 'tool_call')
  const commands = events.filter((e) => e.type === 'command')
  const errors = events.filter((e) => e.type === 'error')
  const failedToolCallCount = toolCalls.filter((e) => e.status === 'failed').length
  const failedCommandCount = commands.filter((e) => e.status === 'failed').length
  const timedOutCommandCount = commands.filter((e) => e.status === 'timed_out').length

  const toolNameCounts = new Map<string, number>()
  for (const e of toolCalls) {
    const name = e.name ?? ''
    toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1)
  }
  const repeatedEntries = [...toolNameCounts.values()].filter((c) => c > 1)
  const repeatedToolCallCount = repeatedEntries.reduce((sum, c) => sum + c - 1, 0)
  const maxRepeatedToolCallNameCount = repeatedEntries.length > 0 ? Math.max(...repeatedEntries) : 0

  return {
    eventCount: events.length,
    messageCount,
    toolCallCount: toolCalls.length,
    commandCount: commands.length,
    errorCount: errors.length,
    failedToolCallCount,
    failedCommandCount,
    timedOutCommandCount,
    adapterTimedOut: trial.result.status === 'timed_out',
    adapterExitCodeNonZero: trial.invocation.exitCode !== null && trial.invocation.exitCode !== 0,
    runtimeErrorDetected: errors.length > 0 || trial.result.status === 'failed',
    workerFailureDetected: trial.result.status !== 'completed' && trial.result.failureKind === 'harness_error',
    repeatedToolCallCount,
    maxRepeatedToolCallNameCount,
  }
}

export function gradeProcess(row: TrialRow, grader: ProcessOptions): GraderResult {
  const options = {
    failOnNonCompletedStatus: true,
    failOnErrorEvents: true,
    failOnFailedOrTimedOutCommands: true,
    failOnFailedToolCalls: true,
    ...grader,
  }
  const process = row.process ?? computeProcessSummary(row.trial)
  const reasons: string[] = []
  let pass = true
  if (options.failOnNonCompletedStatus && row.trial.result.status !== 'completed') {
    pass = false
    reasons.push(`status=${row.trial.result.status}`)
  }
  if (options.failOnErrorEvents && process.errorCount > 0) {
    pass = false
    reasons.push('error events detected')
  }
  if (options.failOnFailedOrTimedOutCommands && process.failedCommandCount + process.timedOutCommandCount > 0) {
    pass = false
    reasons.push('failed/timed_out command events detected')
  }
  if (options.failOnFailedToolCalls && process.failedToolCallCount > 0) {
    pass = false
    reasons.push('failed tool_call events detected')
  }
  if (options.maxToolCalls !== undefined && process.toolCallCount > options.maxToolCalls) {
    pass = false
    reasons.push(`tool calls exceed max (${options.maxToolCalls})`)
  }
  if (options.maxCommands !== undefined && process.commandCount > options.maxCommands) {
    pass = false
    reasons.push(`commands exceed max (${options.maxCommands})`)
  }
  if (
    options.maxRepeatedToolCallNameCount !== undefined &&
    process.maxRepeatedToolCallNameCount > options.maxRepeatedToolCallNameCount
  ) {
    pass = false
    reasons.push(`repeated tool calls exceed max (${options.maxRepeatedToolCallNameCount})`)
  }
  return {
    id: grader.id,
    type: 'process',
    required: grader.required ?? true,
    weight: grader.weight ?? 1,
    skipped: false,
    pass,
    score: pass ? 1 : 0,
    reasoning: pass ? 'Process checks passed.' : reasons.join('; '),
  }
}

/** The minimal projection `src/grader.ts` reads from stdin: just task + result.
 * Drops trajectory (where the 16MB tool outputs live) and invocation (adapter
 * stdout), so the answer grader never touches the heavy fields that broke the
 * harness's single stdout write. */
export function projectForAnswerGrader(row: TrialRow): {
  trial: {
    task: { prompts: string[]; metadata?: Record<string, unknown> }
    result: { message?: string; status: string }
  }
} {
  const trial = row.trial as TrialRow['trial'] & {
    task?: { prompts?: unknown; metadata?: Record<string, unknown> }
  }
  const task = trial.task ?? {}
  const prompts = Array.isArray(task.prompts) ? task.prompts.filter((p): p is string => typeof p === 'string') : []
  return {
    trial: {
      task: { prompts, metadata: task.metadata ?? {} },
      result: {
        message: trial.result.message,
        status: trial.result.status,
      },
    },
  }
}

/** Mirrors the harness computeOverall: required-grader conjunction + weighted
 * score over executed (non-skipped) graders. */
export function computeOverall(row: TrialRow & { graderResults?: GraderResult[] }): {
  pass: boolean
  score: number
  reasoning: string
} {
  if (row.trial.result.status !== 'completed') {
    return {
      pass: false,
      score: 0,
      reasoning: `Trial status '${row.trial.result.status}' forces overall pass=false and score=0.`,
    }
  }
  const executed = (row.graderResults ?? []).filter((r) => !r.skipped)
  const required = executed.filter((r) => r.required)
  const requiredPass = required.every((r) => r.pass === true)
  const weighted = executed.filter((r) => r.score !== null)
  if (weighted.length === 0) {
    return {
      pass: requiredPass,
      score: 0,
      reasoning: requiredPass ? 'No scored graders executed.' : 'At least one required grader failed.',
    }
  }
  const weightedSum = weighted.reduce((sum, r) => sum + (r.score ?? 0) * r.weight, 0)
  const weightTotal = weighted.reduce((sum, r) => sum + r.weight, 0)
  const score = weightTotal === 0 ? 0 : weightedSum / weightTotal
  return {
    pass: requiredPass,
    score,
    reasoning: requiredPass ? 'All required graders passed.' : 'At least one required grader failed.',
  }
}
export interface GradeWithClickhouseOptions {
  trajectoriesPath: string
  gradedPath: string
  summaryPath: string
  /** e.g. "$PWD/clickhouse local" */
  clickhouseCommand: string
  /** e.g. ["bun", "run", "src/grader.ts"] */
  answerGraderCommand: string[]
  processOptions: ProcessOptions
  k: number
  model: string
  /** Skip the LLM judge (mark answer rubric skipped); used when no API key. */
  skipAnswerGrader?: boolean
  concurrency?: number
  /** Trial keys (taskId\ttrialIndex) already graded; skip those rows. */
  gradedKeys?: Set<string>
  /** Append to gradedPath instead of truncating (resume mode). */
  append?: boolean
}

/**
 * Grades trajectories.jsonl without the harness's single stdout write of a
 * ~25MB serialized row (which truncates and kills the harness on huge trials).
 *
 * Flow:
 * 1. streamJsonl reads trajectories.jsonl in chunks (no single 25MB read or
 *    write) — replaces the harness subprocess whose single process.stdout.write
 *    of a ~25MB serialized graded row truncated and killed it on huge trials.
 * 2. For each row, run the answer grader subprocess (src/grader.ts) fed the
 *    minimal projection (task + result.message) — never the 16MB trajectory.
 * 3. Compute overall pass/score/reasoning, write graded.jsonl via a stream.
 * 4. Reuse writeSummaryFromJsonl for summary.json.
 */
export async function gradeWithClickhouse(
  options: GradeWithClickhouseOptions,
): Promise<import('./summary.ts').Summary> {
  const { createWriteStream } = await import('node:fs')
  const { once } = await import('node:events')
  const { ensureDir, streamJsonl } = await import('./io.ts')
  const { writeSummaryFromJsonl } = await import('./summary.ts')
  const { dirname } = await import('node:path')
  const { trialRowKey } = await import('./trial-rows.ts')

  await ensureDir(dirname(options.gradedPath))
  const writer = createWriteStream(options.gradedPath, { flags: options.append ? 'a' : 'w' })
  // Serialize writes: concurrent workers compute grades in parallel (the
  // expensive LLM-judge part) but write graded rows one at a time so only one
  // drain listener is ever pending. Without this, 24 workers each add a
  // once('drain') listener on backpressure, exceeding the default limit and
  // leaking.
  let writeQueue: Promise<void> = Promise.resolve()
  const writeRow = (line: string): Promise<void> => {
    writeQueue = writeQueue.then(
      () =>
        new Promise<void>((resolve) => {
          if (writer.write(`${line}\n`)) resolve()
          else writer.once('drain', () => resolve())
        }),
    )
    return writeQueue
  }

  // Read trajectories via streamJsonl (streams the file in chunks — no single
  // 25MB read or write). This replaces the harness's subprocess, whose single
  // process.stdout.write of a ~25MB serialized graded row truncated and killed
  // it on huge trials. The process rubric is computed in JS (parity with the
  // harness via gradeProcess); the answer rubric runs as a subprocess fed only
  // the minimal projection.
  const gradedKeys = options.gradedKeys ?? new Set<string>()
  const rows: TrialRow[] = []
  for await (const { value } of streamJsonl<TrialRow>(options.trajectoriesPath)) {
    const key = trialRowKey(value as unknown as Record<string, unknown>)
    if (key && gradedKeys.has(key)) continue
    rows.push(value)
  }

  const concurrency = options.concurrency ?? 8
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, rows.length || 1) }, async () => {
    while (index < rows.length) {
      const i = index++
      const row = rows[i] ?? null
      if (row === null) continue
      const graderResults: GraderResult[] = [gradeProcess(row, options.processOptions)]
      if (row.trial.result.status === 'completed' && !options.skipAnswerGrader) {
        const result = await runAnswerGrader(options.answerGraderCommand, projectForAnswerGrader(row))
        graderResults.push(result)
      } else {
        graderResults.push({
          id: 'deepsearchqa-answer',
          type: 'command',
          required: true,
          weight: 1,
          skipped: row.trial.result.status !== 'completed',
          pass: null,
          score: null,
          reasoning: options.skipAnswerGrader
            ? 'Skipped: answer grader disabled (no API key).'
            : `Skipped because when='completed' and trial status is '${row.trial.result.status}'.`,
        })
      }
      const overall = computeOverall({ ...row, graderResults })
      const graded = { ...row, process: row.process ?? computeProcessSummary(row.trial), graderResults, ...overall }
      await writeRow(JSON.stringify(graded))
    }
  })
  await Promise.all(workers)
  writer.end()
  await once(writer, 'finish')

  return writeSummaryFromJsonl(options.summaryPath, options.gradedPath, { k: options.k, model: options.model })
}

async function runAnswerGrader(command: string[], input: unknown): Promise<GraderResult> {
  const proc = Bun.spawn({ cmd: command, stdout: 'pipe', stderr: 'inherit', stdin: 'pipe' })
  proc.stdin.write(JSON.stringify(input))
  proc.stdin.end()
  let stdout = ''
  for await (const chunk of proc.stdout) stdout += new TextDecoder().decode(chunk)
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    return {
      id: 'deepsearchqa-answer',
      type: 'command',
      required: true,
      weight: 1,
      skipped: false,
      pass: false,
      score: 0,
      reasoning: `answer grader exited non-zero (${exitCode}).`,
    }
  }
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    return {
      id: 'deepsearchqa-answer',
      type: 'command',
      required: true,
      weight: 1,
      skipped: false,
      pass: Boolean(parsed.pass),
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      outcome: parsed.outcome as Record<string, unknown> | undefined,
    }
  } catch (e) {
    return {
      id: 'deepsearchqa-answer',
      type: 'command',
      required: true,
      weight: 1,
      skipped: false,
      pass: false,
      score: 0,
      reasoning: `answer grader returned non-JSON: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
