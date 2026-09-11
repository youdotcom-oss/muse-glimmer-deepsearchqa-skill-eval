import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isForce, isRetryFailed, readIntegerEnv, readStringEnv } from '../src/env.ts'
import { gradeWithClickhouse } from '../src/grade-clickhouse.ts'
import { ensureDir, removeIfExists } from '../src/io.ts'
import { collectLatestRowLines, collectRowKeys, pruneFailedGradedRows } from '../src/trial-rows.ts'

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
    // RETRY_FAILED=1: prune every FAILED graded row so all regenerated trials
    // become pending. Failed rows score 0 and re-grade for free (the answer
    // judge skips non-completed trials), so this is safe regardless of which
    // tasks a prior RETRY_FAILED generate actually regenerated. Graded rows
    // are derived data — safe to prune and regenerate.
    const pruned = await pruneFailedGradedRows(GRADED_PATH)
    gradedKeys = await collectRowKeys(GRADED_PATH)
    console.error(`RETRY_FAILED=1: pruned ${pruned} failed graded row(s); re-grading pending trials`)
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
    latestLines: latestTrajectoryLines,
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
