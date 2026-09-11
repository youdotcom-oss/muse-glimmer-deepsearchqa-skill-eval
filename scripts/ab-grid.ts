/**
 * A/B grid runner: 2x2 cells (MAX_TOOL_CALLS 10/15 x THINKING_LEVEL medium/high)
 * over the same first-LIMIT tasks (default 50) at K=1, each cell with isolated
 * artifact paths under AB_DIR (default data/ab). Cells run SEQUENTIALLY so
 * OpenRouter rate limits do not cross-contaminate cells.
 *
 * Usage:
 *   MODEL=<model> bun run ab
 *   MODEL=<model> LIMIT=50 K=1 AB_DIR=data/ab bun run ab
 *
 * Skips a cell whose summary already exists (delete it or the cell's files to
 * rerun). Prints a comparison table at the end from each cell's summary.json.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AbCell {
  name: string
  maxToolCalls: string
  thinking: string
}

export function buildCells(): AbCell[] {
  return [
    { name: 'cap10-med', maxToolCalls: '10', thinking: 'medium' },
    { name: 'cap10-high', maxToolCalls: '10', thinking: 'high' },
    { name: 'cap15-med', maxToolCalls: '15', thinking: 'medium' },
    { name: 'cap15-high', maxToolCalls: '15', thinking: 'high' },
  ]
}

export interface CellEnvOptions {
  model: string
  limit: string
  k: string
  abDir: string
  baseEnv: Record<string, string | undefined>
}

export function cellEnv(cell: AbCell, options: CellEnvOptions): Record<string, string | undefined> {
  const base = `${options.abDir}/${cell.name}`
  return {
    ...options.baseEnv,
    MODEL: options.model,
    LIMIT: options.limit,
    K: options.k,
    FORCE: '1',
    LABEL: `ab-${cell.name}`,
    MAX_TOOL_CALLS: cell.maxToolCalls,
    THINKING_LEVEL: cell.thinking,
    TRAJECTORIES_PATH: `${base}-traj.jsonl`,
    GRADED_PATH: `${base}-graded.jsonl`,
    SUMMARY_PATH: `${base}-summary.json`,
    RESULTS_PATH: `${base}-results.jsonl`,
  }
}

interface HeadlineMetrics {
  raw: { averageScore?: number; passRate?: number; exactPassAtK?: number; trialCount?: number }
}

export function renderComparison(cells: Array<{ name: string; summary: HeadlineMetrics | null }>): string {
  const lines: string[] = ['cell\ttrials\tavg F1\tpass rate\tpass@K']
  for (const { name, summary } of cells) {
    if (summary === null) {
      lines.push(`${name}\t(no summary)`)
      continue
    }
    const r = summary.raw
    lines.push(
      [
        name,
        String(r.trialCount ?? '?'),
        (r.averageScore ?? 0).toFixed(4),
        (r.passRate ?? 0).toFixed(4),
        (r.exactPassAtK ?? 0).toFixed(4),
      ].join('\t'),
    )
  }
  return lines.join('\n')
}

interface GridOptions {
  model: string
  limit: string
  k: string
  abDir: string
}

async function runCell(cell: AbCell, options: GridOptions): Promise<void> {
  const summaryPath = join(options.abDir, `${cell.name}-summary.json`)
  if (existsSync(summaryPath)) {
    console.error(`=== ${cell.name}: summary exists, skipping (delete ${summaryPath} to rerun) ===`)
    return
  }
  console.error(`\n=== ${cell.name}: MAX_TOOL_CALLS=${cell.maxToolCalls} THINKING_LEVEL=${cell.thinking} ===`)
  const env = cellEnv(cell, { ...options, baseEnv: process.env })
  for (const cmd of [
    ['bun', 'run', 'eval'],
    ['bun', 'run', 'export-results'],
  ]) {
    const proc = Bun.spawn({
      cmd,
      env: env as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`Cell ${cell.name}: '${cmd.join(' ')}' exited with code ${code}`)
  }
}

async function runGrid(): Promise<void> {
  const model = process.env.MODEL ?? ''
  if (!model) throw new Error('MODEL is required, e.g. MODEL=meta/muse-glimmer-30b bun run ab')
  const options: GridOptions = {
    model,
    limit: process.env.LIMIT ?? '50',
    k: process.env.K ?? '1',
    abDir: process.env.AB_DIR ?? 'data/ab',
  }
  mkdirSync(options.abDir, { recursive: true })
  const cells = buildCells()
  for (const cell of cells) await runCell(cell, options)

  const results: Array<{ name: string; summary: HeadlineMetrics | null }> = []
  for (const cell of cells) {
    const summaryPath = join(options.abDir, `${cell.name}-summary.json`)
    const summary = existsSync(summaryPath) ? ((await Bun.file(summaryPath).json()) as HeadlineMetrics) : null
    results.push({ name: cell.name, summary })
  }
  console.error(`\n=== A/B comparison (${options.limit} tasks, K=${options.k}) ===`)
  console.error(renderComparison(results))
}

if (import.meta.main) await runGrid()
