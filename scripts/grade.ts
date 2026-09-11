import { once } from 'node:events'
import { createWriteStream, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isForce, isRetryFailed, readIntegerEnv, readStringEnv } from '../src/env.ts'
import { gradeWithClickhouse } from '../src/grade-clickhouse.ts'
import { ensureDir, removeIfExists, streamJsonl } from '../src/io.ts'
import { collectAllFailedTaskIds, collectLatestRowLines, collectRowKeys } from '../src/trial-rows.ts'

const TRAJECTORIES_PATH = readStringEnv('TRAJECTORIES_PATH', 'data/trajectories.jsonl')
const GRADED_PATH = readStringEnv('GRADED_PATH', 'data/graded.jsonl')
const SUMMARY_PATH = readStringEnv('SUMMARY_PATH', 'data/summary.json')
const K = readIntegerEnv('K', 3, 1)
const CONCURRENCY =
  process.env.GRADE_CONCURRENCY === undefined || process.env.GRADE_CONCURRENCY === ''
    ? readIntegerEnv('CONCURRENCY', 24, 1)
    : readIntegerEnv('GRADE_CONCURRENCY', 24, 1)
const MODEL = readStringEnv('MODEL')

await main()

async function main(): Promise<void> {
  if (!(await Bun.file(TRAJECTORIES_PATH).exists()))
    throw new Error(`${TRAJECTORIES_PATH} does not exist; run bun run generate first.`)
  await ensureDir(dirname(GRADED_PATH))
  const latestTrajectoryLines = await collectLatestRowLines(TRAJECTORIES_PATH)
  let gradedKeys = isForce() ? new Set<string>() : await collectRowKeys(GRADED_PATH)

  if (isRetryFailed()) {
    // RETRY_FAILED=1: re-grade the all-failed tasks by pruning their graded
    // rows first; their regenerated trajectories are the latest row per key,
    // so the summary's latest-row dedupe picks the new grades. Graded rows are
    // derived data — safe to prune and regenerate.
    const allFailed = await collectAllFailedTaskIds(TRAJECTORIES_PATH, K)
    await pruneGradedRowsForTasks(GRADED_PATH, allFailed)
    gradedKeys = await collectRowKeys(GRADED_PATH)
    console.error(`RETRY_FAILED=1: re-grading ${allFailed.size} all-failed task(s)`)
  }

  const pendingCount = latestTrajectoryLines.size - gradedKeys.size

  if (pendingCount <= 0) {
    console.error(`No grading work left. ${GRADED_PATH} already has grades for all trajectories.`)
    return
  }

  if (isForce()) await removeIfExists(GRADED_PATH)

  const summary = await gradeWithClickhouse({
    trajectoriesPath: TRAJECTORIES_PATH,
    gradedPath: GRADED_PATH,
    summaryPath: SUMMARY_PATH,
    clickhouseCommand: parseClickHouseCommand(process.env.CLICKHOUSE_LOCAL),
    answerGraderCommand: ['bun', 'run', 'src/grader.ts'],
    processOptions: { id: 'process', weight: 0.1, failOnFailedToolCalls: false },
    k: K,
    model: MODEL,
    concurrency: CONCURRENCY,
    gradedKeys,
    append: !isForce(),
  })
  console.error(
    `Wrote ${SUMMARY_PATH}: raw avg=${summary.raw.averageScore.toFixed(4)}, adjusted avg=${summary.adjusted.averageScore.toFixed(4)}`,
  )
}

// Mirrors src/query.ts parseClickHouseCommand: prefer CLICKHOUSE_LOCAL env, then
// the vendored repo-root binary, then PATH lookup for clickhouse-local.
function parseClickHouseCommand(value: string | undefined): string {
  const command = value?.trim()
  if (command) return command
  const vendored = join(import.meta.dir, '..', 'clickhouse')
  if (existsSync(vendored)) return `${vendored} local`
  return 'clickhouse-local'
}

/** Streaming rewrite of graded.jsonl excluding rows whose taskId is in the
 * prune set. Atomic via temp file + rename; skips entirely when nothing to
 * prune so a plain re-grade never rewrites a multi-hundred-MB artifact. */
async function pruneGradedRowsForTasks(path: string, taskIds: Set<string>): Promise<void> {
  if (taskIds.size === 0) return
  if (!existsSync(path)) return
  const tmpPath = `${path}.prune-tmp`
  const writer = createWriteStream(tmpPath)
  let pruned = 0
  for await (const { value } of streamJsonl<{ taskId?: unknown }>(path)) {
    if (typeof value.taskId === 'string' && taskIds.has(value.taskId)) {
      pruned += 1
      continue
    }
    if (!writer.write(`${JSON.stringify(value)}\n`)) await once(writer, 'drain')
  }
  writer.end()
  await once(writer, 'finish')
  const { rename } = await import('node:fs/promises')
  await rename(tmpPath, path)
  console.error(`Pruned ${pruned} graded row(s) for ${taskIds.size} retried task(s)`)
}
