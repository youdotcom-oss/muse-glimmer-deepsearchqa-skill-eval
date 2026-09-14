/**
 * Failure-pattern analysis v2: for genuinely-researched failing trials
 * (excluding timed_out/failed infrastructure artifacts), classify where the
 * information chain broke:
 *
 *   A. query-authoring failure (low query diversity / repetitive rewording)
 *   B. extraction failure (sub-model dropped needed facts; gap notes say so)
 *   C. synthesis failure (facts extracted, answer incoherent/wrong selection)
 *   D. surface failure (majority of reads report not_found)
 *
 * Usage: bun run scripts/failure-analysis.ts [--limit 60]
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg === -1 ? 60 : Number(process.argv[limitArg + 1] ?? 60)

interface GradedRow {
  score: number
  answer: string
  reasoning: string
  status: string
}

async function loadGraded(): Promise<Map<string, GradedRow>> {
  const map = new Map<string, GradedRow>()
  const rl = createInterface({ input: createReadStream('data/graded.jsonl') })
  for await (const line of rl) {
    const r = JSON.parse(line)
    map.set(`${r.taskId}:${r.trialIndex ?? 0}`, {
      score: r.score ?? 0,
      answer: r.trial?.result?.message ?? '',
      reasoning:
        ((Array.isArray(r.graderResults) ? r.graderResults : Object.values(r.graderResults ?? {})).find(
          (x: Record<string, unknown>) => x.id === 'deepsearchqa-answer',
        )?.reasoning as string | undefined) ?? '',
      status: r.trial?.result?.status ?? '?',
    })
  }
  return map
}

interface ExtractionRecord {
  goalStatus: string
  factCount: number
  factList: string[]
  gaps: string[]
}

async function* streamTrajectories() {
  const rl = createInterface({ input: createReadStream('data/trajectories.jsonl') })
  for await (const line of rl) {
    try {
      yield JSON.parse(line)
    } catch {
      // skip malformed
    }
  }
}

function extractRlmRecords(evts: unknown[]): ExtractionRecord[] {
  const out: ExtractionRecord[] = []
  for (const e of evts as Array<Record<string, unknown>>) {
    if (e.type !== 'tool_call' || e.status !== 'completed') continue
    if (e.name !== 'you-search' && e.name !== 'you-contents') continue
    const rlm = (e.output as Record<string, unknown> | undefined)?.details as Record<string, unknown> | undefined
    const r = rlm?.rlm as Record<string, unknown> | undefined
    if (!r) continue
    out.push({
      goalStatus: String(r.goalStatus ?? ''),
      factCount: Number(r.facts ?? 0),
      factList: [],
      gaps: Array.isArray(r.unresolvedGaps) ? (r.unresolvedGaps as string[]) : [],
    })
  }
  return out
}

function extractQueries(evts: unknown[]): string[] {
  return (evts as Array<Record<string, unknown>>)
    .filter((e) => e.type === 'tool_call' && e.name === 'you-search' && e.status === 'started')
    .map((e) => String((e.input as Record<string, unknown>)?.query ?? ''))
    .filter((q) => q.length > 0)
}

function coreTerms(q: string): Set<string> {
  return new Set(
    q
      .toLowerCase()
      .replace(/site:[a-z.]+/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size < 2 || b.size < 2) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : inter / union
}

async function main(): Promise<void> {
  const graded = await loadGraded()

  const failing: Array<{ key: string; taskId: string; row: GradedRow }> = []
  const infra = { timedOut: 0, providerFailed: 0 }
  for (const [key, row] of graded) {
    if (row.score >= 0.8) continue
    if (row.status === 'timed_out') {
      infra.timedOut++
      continue
    }
    if (row.status === 'failed') {
      infra.providerFailed++
      continue
    }
    failing.push({ key, taskId: key.split(':')[0] ?? '', row })
  }
  // lowest-scoring first
  failing.sort((a, b) => a.row.score - b.row.score)
  const sample = failing.slice(0, LIMIT)
  const sampleKeys = new Set(sample.map((s) => s.key))
  console.error(
    `non-FC trials: ${failing.length} | infrastructure artifacts excluded: ${infra.timedOut} timed_out + ${infra.providerFailed} provider-failed`,
  )
  console.error(`analyzing ${sample.length} lowest-scoring researched failures\n`)

  const found = new Map<string, { queries: string[]; extractions: ExtractionRecord[]; answer: string }>()
  for await (const row of streamTrajectories()) {
    const key = `${row.taskId}:${row.trialIndex ?? 0}`
    if (!sampleKeys.has(key) || found.has(key)) continue
    const evts = row.trial.trajectory as unknown[]
    found.set(key, {
      queries: extractQueries(evts),
      extractions: extractRlmRecords(evts),
      answer: ((row.trial?.result as Record<string, unknown> | undefined)?.message as string | undefined) ?? '',
    })
  }

  // classification + aggregate signal measurement
  const counts = {
    queryAuthoring: 0,
    extractionDrop: 0,
    synthesisSelection: 0,
    surfaceUnreachable: 0,
    dataPresentButWrong: 0,
    thinEvidence: 0,
  }
  const examples: string[] = []
  let paraphraseRateSum = 0,
    paraphraseTrials = 0
  let notFoundSum = 0,
    extTotal = 0

  for (const s of sample) {
    const data = found.get(s.key)
    if (!data) continue
    const extractions = data.extractions
    const totalFacts = extractions.reduce((acc, r) => acc + r.factCount, 0)
    const notFoundRate =
      extractions.length > 0 ? extractions.filter((r) => r.goalStatus === 'not_found').length / extractions.length : 0
    notFoundSum += notFoundRate
    extTotal += extractions.length > 0 ? 1 : 0

    // consecutive paraphrase rate (structural rewording without new facets)
    let paraphrasePairs = 0,
      totalPairs = 0
    for (let i = 1; i < data.queries.length; i++) {
      totalPairs++
      const prev = data.queries[i - 1] ?? ''
      const cur = data.queries[i] ?? ''
      if (jaccard(coreTerms(prev), coreTerms(cur)) >= 0.7) paraphrasePairs++
    }
    const paraRate = totalPairs > 0 ? paraphrasePairs / totalPairs : 0
    paraphraseRateSum += paraRate
    paraphraseTrials++

    const uniqueQueries = new Set(data.queries.map((q) => q.replace(/\s+/g, ' ').toLowerCase().trim())).size
    const queryDiversity = data.queries.length > 0 ? uniqueQueries / data.queries.length : 1

    // gaps explicitly saying "the data is not in this document"
    const gapSaysAbsent = data.extractions
      .flatMap((r) => r.gaps)
      .filter((g) => /not present|not found|not contain|not include|unavailable|not accessible/i.test(g)).length
    const gapTotal = data.extractions.reduce((acc, r) => acc + r.gaps.length, 0)

    let cls: string
    if (notFoundRate >= 0.6) {
      cls = 'surface-unreachable'
      counts.surfaceUnreachable++
    } else if (queryDiversity < 0.6) {
      cls = 'query-authoring'
      counts.queryAuthoring++
    } else if (totalFacts === 0 || (extractions.length > 0 && totalFacts / extractions.length < 1.5)) {
      cls = 'extraction-drop'
      counts.extractionDrop++
    } else if (totalFacts >= 8 && s.row.score < 0.5) {
      cls = 'synthesis-selection'
      counts.synthesisSelection++
    } else if (gapTotal > 0 && gapSaysAbsent / gapTotal >= 0.5) {
      cls = 'extraction-drop'
      counts.extractionDrop++
    } else {
      cls = 'thin-evidence'
      counts.thinEvidence++
    }
    examples.push(
      `${s.taskId} [${cls}] score=${s.row.score.toFixed(2)} queries=${data.queries.length} (para ${Math.round(paraRate * 100)}%) facts=${totalFacts} nfRate=${Math.round(notFoundRate * 100)}%`,
    )
  }

  console.log('=== BREAK-POINT CLASSIFICATION (researched failures only) ===')
  console.log(`query-authoring failure (rewording churn, low diversity):   ${counts.queryAuthoring}`)
  console.log(`extraction failure (sub-model dropped needed facts):        ${counts.extractionDrop}`)
  console.log(`synthesis/selection failure (facts present, wrong assembly): ${counts.synthesisSelection}`)
  console.log(`surface failure (majority of reads: not_found):             ${counts.surfaceUnreachable}`)
  console.log(`thin evidence (some facts but not enough):                  ${counts.thinEvidence}`)
  console.log(
    `\naggregate: avg consecutive-paraphrase rate ${((paraphraseRateSum / Math.max(1, paraphraseTrials)) * 100).toFixed(1)}% | avg not_found rate ${((notFoundSum / Math.max(1, extTotal)) * 100).toFixed(1)}%`,
  )
  console.log('\n=== SAMPLES ===')
  for (const e of examples) console.log(e)
}

await main()
