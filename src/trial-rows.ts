import { once } from 'node:events'
import { createWriteStream, existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { streamJsonl } from './io.ts'

export type TrialJsonRow = Record<string, unknown>

const encoder = new TextEncoder()

export function trialRowKey(row: TrialJsonRow): string {
  return typeof row.taskId === 'string' && typeof row.trialIndex === 'number' ? `${row.taskId}\t${row.trialIndex}` : ''
}

export async function collectRowKeys(path: string): Promise<Set<string>> {
  const keys = new Set<string>()
  for await (const { value } of streamJsonl<TrialJsonRow>(path)) {
    const key = trialRowKey(value)
    if (key) keys.add(key)
  }
  return keys
}

export async function collectLatestRowLines(path: string): Promise<Map<string, number>> {
  const latestLines = new Map<string, number>()
  for await (const { line, value } of streamJsonl<TrialJsonRow>(path)) {
    const key = trialRowKey(value)
    if (key) latestLines.set(key, line)
  }
  return latestLines
}

export async function collectTrialCounts(path: string): Promise<Map<string, number>> {
  const byTask = new Map<string, Set<number>>()
  for await (const { value } of streamJsonl<TrialJsonRow>(path)) {
    const taskId = typeof value.taskId === 'string' ? value.taskId : ''
    const trialIndex = typeof value.trialIndex === 'number' ? value.trialIndex : undefined
    if (!taskId || trialIndex === undefined) continue
    const trialIndices = byTask.get(taskId) ?? new Set<number>()
    trialIndices.add(trialIndex)
    byTask.set(taskId, trialIndices)
  }
  return new Map([...byTask.entries()].map(([taskId, trialIndices]) => [taskId, trialIndices.size]))
}

export async function* streamLatestRows(path: string, latestLines: Map<string, number>): AsyncGenerator<TrialJsonRow> {
  for await (const { line, value } of streamJsonl<TrialJsonRow>(path)) {
    const key = trialRowKey(value)
    if (key && latestLines.get(key) === line) yield value
  }
}

/** Task ids whose latest trial rows (per task+trialIndex key) number at least
 * `k` and are ALL status=failed — the RETRY_FAILED regeneration set. Reads only
 * the latest row per key so superseded retries don't count. */
export async function collectAllFailedTaskIds(path: string, k: number): Promise<Set<string>> {
  const latestLines = await collectLatestRowLines(path)
  const trialsByTask = new Map<string, Array<string | undefined>>()
  for await (const row of streamLatestRows(path, latestLines)) {
    const taskId = typeof row.taskId === 'string' ? row.taskId : ''
    const trialIndex = typeof row.trialIndex === 'number' ? row.trialIndex : undefined
    if (!taskId || trialIndex === undefined) continue
    const trials = trialsByTask.get(taskId) ?? []
    trials[trialIndex] = asTrialStatus(row)
    trialsByTask.set(taskId, trials)
  }
  const allFailed = new Set<string>()
  for (const [taskId, trials] of trialsByTask) {
    const statuses = trials.filter((status): status is string => status !== undefined)
    if (statuses.length >= k && statuses.every((status) => status === 'failed')) allFailed.add(taskId)
  }
  return allFailed
}

function asTrialStatus(row: TrialJsonRow): string | undefined {
  const trial = row.trial as { result?: { status?: unknown } } | undefined
  const status = trial?.result?.status
  return typeof status === 'string' ? status : undefined
}

/** Streaming rewrite of a graded JSONL file excluding rows whose trial status
 * is failed. Failed rows score 0 and re-grade for free (the answer judge skips
 * non-completed trials), so pruning them is the RETRY_FAILED re-grade set:
 * every regenerated trial (whose key was previously failed) becomes pending.
 * Atomic via temp file + rename. Returns the number of pruned rows. */
export async function pruneFailedGradedRows(path: string): Promise<number> {
  if (!existsSync(path)) return 0
  const tmpPath = `${path}.prune-tmp`
  const writer = createWriteStream(tmpPath)
  let pruned = 0
  for await (const { value } of streamJsonl<TrialJsonRow>(path)) {
    if (asTrialStatus(value) === 'failed') {
      pruned += 1
      continue
    }
    if (!writer.write(`${JSON.stringify(value)}\n`)) await once(writer, 'drain')
  }
  writer.end()
  await once(writer, 'finish')
  if (pruned === 0) {
    await rm(tmpPath, { force: true })
    return 0
  }
  await rename(tmpPath, path)
  return pruned
}

export function* chunkRowsForHarness(rows: Iterable<TrialJsonRow>, maxBytes: number): Generator<TrialJsonRow[]> {
  let chunk: TrialJsonRow[] = []
  let chunkBytes = 0

  for (const row of rows) {
    const rowBytes = jsonlRowByteLength(row)
    if (chunk.length > 0 && chunkBytes + rowBytes > maxBytes) {
      yield chunk
      chunk = []
      chunkBytes = 0
    }
    chunk.push(row)
    chunkBytes += rowBytes
  }

  if (chunk.length > 0) yield chunk
}

export async function* streamChunksForHarness(
  rows: AsyncIterable<TrialJsonRow>,
  maxBytes: number,
): AsyncGenerator<TrialJsonRow[]> {
  let chunk: TrialJsonRow[] = []
  let chunkBytes = 0

  for await (const row of rows) {
    const rowBytes = jsonlRowByteLength(row)
    if (chunk.length > 0 && chunkBytes + rowBytes > maxBytes) {
      yield chunk
      chunk = []
      chunkBytes = 0
    }
    chunk.push(row)
    chunkBytes += rowBytes
  }

  if (chunk.length > 0) yield chunk
}

function jsonlRowByteLength(row: TrialJsonRow): number {
  return encoder.encode(JSON.stringify(row)).length + 1
}
