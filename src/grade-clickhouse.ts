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
  answerGraderModel: string
  processOptions: ProcessOptions
  k: number
  model: string
  /** Skip the LLM judge (mark answer rubric skipped); used when no API key. */
  skipAnswerGrader?: boolean
  concurrency?: number
}

/**
 * Grades trajectories.jsonl without the harness's single stdout write of a
 * ~25MB serialized row (which truncates and kills the harness on huge trials).
 *
 * Flow:
 * 1. clickhouse-local reads trajectories.jsonl directly (file, no stdio) and
 *    emits one row per trial with the process summary fields computed.
 * 2. For each row, run the answer grader subprocess (src/grader.ts) fed the
 *    minimal projection (task + result.message) — never the 16MB trajectory.
 * 3. Compute overall pass/score/reasoning, write graded.jsonl.
 * 4. Reuse writeSummaryFromJsonl for summary.json.
 */

/**
 * Grades trajectories.jsonl without the harness's single stdout write of a
 * ~25MB serialized row (which truncates and kills the harness on huge trials).
 *
 * Flow:
 * 1. clickhouse-local reads trajectories.jsonl directly (file, no stdio) and
 *    re-emits each trial row as one JSON line — clickhouse reads the file, so
 *    there is no single stdout write of a 25MB string to break.
 * 2. For each row, compute the process summary in JS (parity with the harness
 *    is easier to keep than re-expressing every counter in SQL) and run the
 *    answer grader subprocess (src/grader.ts) fed the minimal projection
 *    (task + result.message) — never the 16MB trajectory.
 * 3. Compute overall pass/score/reasoning, write graded.jsonl.
 * 4. Reuse writeSummaryFromJsonl for summary.json.
 */
export async function gradeWithClickhouse(
  options: GradeWithClickhouseOptions,
): Promise<import('./summary.ts').Summary> {
  const { createWriteStream } = await import('node:fs')
  const { once } = await import('node:events')
  const { ensureDir } = await import('./io.ts')
  const { writeSummaryFromJsonl } = await import('./summary.ts')
  const { dirname } = await import('node:path')

  await ensureDir(dirname(options.gradedPath))
  const writer = createWriteStream(options.gradedPath, { flags: 'w' })
  const writeRow = (line: string): void => {
    if (!writer.write(`${line}\n`)) void once(writer, 'drain')
  }

  // clickhouse reads the file directly and emits each trial row as one JSON
  // line. This is the key difference from the harness: no single
  // process.stdout.write of a ~25MB serialized string.
  const chQuery = `SELECT json FROM file('${options.trajectoriesPath.replace(/'/g, "''")}', 'JSONAsString', 'json String') FORMAT JSONEachRow`
  const cmdParts = [...options.clickhouseCommand.trim().split(/\s+/), '--query', chQuery]
  const ch = Bun.spawn({ cmd: cmdParts, stdout: 'pipe', stderr: 'inherit' })

  const decoder = new TextDecoder()
  let buffer = ''
  const rows: TrialRow[] = []
  for await (const chunk of ch.stdout) {
    buffer += decoder.decode(chunk, { stream: true })
    let ni = buffer.indexOf('\n')
    while (ni !== -1) {
      const line = buffer.slice(0, ni)
      buffer = buffer.slice(ni + 1)
      if (line.trim()) {
        try {
          // clickhouse emits {"json":"<full row json string>"} in JSONEachRow;
          // the full row is the JSON-encoded string value of that field.
          const envelope = JSON.parse(line) as { json: string }
          rows.push(JSON.parse(envelope.json) as TrialRow)
        } catch (_e) {}
      }
      ni = buffer.indexOf('\n')
    }
  }
  const exitCode = await ch.exited
  if (exitCode !== 0) throw new Error(`clickhouse exited with code ${exitCode}`)

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
      writeRow(JSON.stringify(graded))
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
