import { describe, expect, test } from 'bun:test'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Usage } from '@earendil-works/pi-ai'
import {
  agePath,
  chunkText,
  DUMP_DIR_PREFIX,
  DumpStore,
  EXTRACTION_SYSTEM_PROMPT,
  FULL_PAGE_STEERING_NOTE,
  formatExtractionFallback,
  formatExtractionSuccess,
  formatStructuredExtraction,
  isFullPageSearch,
  narrowToGoal,
  parseExtractionContract,
  RLM_CONFIG,
  type RlmConfig,
  runChunkedExtraction,
  type SubCall,
  sweepStaleDumpDirs,
} from '../src/rlm.ts'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function fakeUsage(n: number): Usage {
  return {
    input: n,
    output: n,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: n * 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 1000 },
  }
}

const testConfig: Pick<RlmConfig, 'chunkChars' | 'maxChunks'> = { chunkChars: 200, maxChunks: 3 }

describe('RLM_CONFIG (fixed constants, no env knobs)', () => {
  test('chunks fit muse 131k window at measured ~2 chars/token web density', () => {
    // Measured in the smoke: web content is ~2 chars/token (52k tokens ≈ 100k chars),
    // so 300k chars ≈ 150k tokens — over the 131,072 window. 200k chars ≈ 100k tokens.
    expect(RLM_CONFIG.chunkChars).toBe(200_000)
    expect(RLM_CONFIG.maxChunks).toBe(8)
  })

  test('sub-call output is capped (latency: sub-calls are output-bound, ~230 tok/s)', () => {
    expect(RLM_CONFIG.maxOutputTokens).toBe(1_500)
    // The prompt carries the same instruction so the model stops before the cap.
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/1,?200 tokens|dense/i)
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/no preamble|no introduction/i)
  })
})

describe('chunkText', () => {
  test('returns a single chunk when text fits', () => {
    expect(chunkText('hello', 100)).toEqual(['hello'])
    expect(chunkText('x'.repeat(100), 100)).toEqual(['x'.repeat(100)])
  })

  test('splits oversized text into chunks no larger than chunkChars, preferring newline boundaries', () => {
    const line = 'a'.repeat(90)
    const text = Array.from({ length: 10 }, () => line).join('\n') // ~909 chars
    const chunks = chunkText(text, 200)
    expect(chunks.length).toBeGreaterThan(3)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200)
      expect(chunk.length).toBeGreaterThan(0)
    }
    // Newline preference: every chunk except the last ends at a line boundary.
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith('\n')).toBe(true)
    // Lossless: concatenation reproduces the input.
    expect(chunks.join('')).toBe(text)
  })

  test('hard-splits when there is no newline within the window', () => {
    const text = 'b'.repeat(500)
    const chunks = chunkText(text, 200)
    expect(chunks).toEqual(['b'.repeat(200), 'b'.repeat(200), 'b'.repeat(100)])
  })
})

describe('runChunkedExtraction', () => {
  test('single chunk: one sub-call, no merge pass', async () => {
    const calls: string[] = []
    const call: SubCall = async (_system, user) => {
      calls.push(user)
      return { text: 'EXTRACTED', usage: fakeUsage(10) }
    }
    const outcome = await runChunkedExtraction(call, 'small doc', 'find the thing', testConfig)
    expect(outcome.text).toBe('EXTRACTED')
    expect(outcome.chunks).toBe(1)
    expect(outcome.truncatedToChunks).toBe(false)
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('find the thing')
    expect(calls[0]).toContain('small doc')
    expect(calls[0]).not.toContain('chunk 1 of')
    expect(outcome.usage.input).toBe(10)
  })

  test('multi chunk: one sub-call per chunk plus one merge pass, usage summed', async () => {
    const prompts: string[] = []
    const call: SubCall = async (_system, user) => {
      prompts.push(user)
      return { text: `part${prompts.length}`, usage: fakeUsage(10) }
    }
    const raw = 'x'.repeat(450) // 3 chunks at 200 chars
    const outcome = await runChunkedExtraction(call, raw, 'goal', testConfig)
    expect(outcome.chunks).toBe(3)
    expect(prompts.length).toBe(4) // 3 map + 1 merge
    expect(prompts[0]).toContain('chunk 1 of 3')
    expect(prompts[2]).toContain('chunk 3 of 3')
    // Merge prompt carries the per-chunk extractions.
    expect(prompts[3]).toContain('part1')
    expect(prompts[3]).toContain('part3')
    expect(outcome.text).toBe('part4')
    expect(outcome.usage.input).toBe(40)
    expect(outcome.usage.cost.total).toBeCloseTo(0.04)
  })

  test('input beyond maxChunks * chunkChars is truncated before extraction', async () => {
    let sawLength = 0
    const call: SubCall = async (_system, user) => {
      sawLength = Math.max(sawLength, user.length)
      return { text: 'E', usage: undefined }
    }
    const raw = 'y'.repeat(10_000) // max input = 3 * 200 = 600
    const outcome = await runChunkedExtraction(call, raw, 'goal', testConfig)
    expect(outcome.truncatedToChunks).toBe(true)
    expect(outcome.chunks).toBe(3)
    expect(sawLength).toBeLessThan(1000) // prompts wrap at most 600 chars of document
    expect(outcome.usage.input).toBe(0) // missing usage contributes zero
  })

  test('chunks extract concurrently (map is parallel; merge waits for all)', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []
    const call: SubCall = async (_system, user) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      // Stagger completion so a sequential loop would finish in order while
      // a parallel one overlaps.
      if (user.includes('Merge them')) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return { text: 'MERGED', usage: fakeUsage(10) }
      }
      const n = Number(user.match(/chunk (\d+)/)?.[1] ?? 0)
      await new Promise((resolve) => setTimeout(resolve, 30 - n * 5))
      active -= 1
      order.push(n)
      return { text: `part${n}`, usage: fakeUsage(10) }
    }
    const raw = 'x'.repeat(450) // 3 chunks
    const outcome = await runChunkedExtraction(call, raw, 'goal', testConfig)
    expect(maxActive).toBeGreaterThan(1) // actually overlapped
    expect(outcome.chunks).toBe(3)
    expect(outcome.text).toBe('MERGED') // merge still runs after all chunks
    // Order-independent: all chunks fed the merge regardless of finish order.
    expect([...order].sort().join()).toBe('1,2,3')
    expect(outcome.usage.input).toBe(40)
  })

  test('a failing sub-call rejects (caller falls back to raw text)', async () => {
    const call: SubCall = async () => {
      throw new Error('provider 500')
    }
    await expect(runChunkedExtraction(call, 'doc', 'goal', testConfig)).rejects.toThrow('provider 500')
  })
})

describe('DumpStore', () => {
  test('write records size and path; cleanup removes the dir', async () => {
    const store = new DumpStore()
    const { path, bytes } = await store.write('you-contents', 'x'.repeat(26))
    expect(bytes).toBe(26)
    expect(store.rootPath).toBeTruthy()
    expect(path.startsWith(store.rootPath as string)).toBe(true)
    expect(await pathExists(path)).toBe(true)
    await store.cleanup()
    expect(await pathExists(path)).toBe(false)
  })

  test('cleanup with nothing written is a no-op', async () => {
    const fresh = new DumpStore()
    await fresh.cleanup() // no dir created, nothing to delete
    expect(fresh.rootPath).toBeUndefined()
  })
})

describe('sweepStaleDumpDirs', () => {
  const staleName = `you-dumps-0-rlmtest-stale-${process.pid}`
  const freshName = `you-dumps-0-rlmtest-fresh-${process.pid}`
  const ownName = `${DUMP_DIR_PREFIX}rlmtest-own`
  const stalePath = join(tmpdir(), staleName)
  const freshPath = join(tmpdir(), freshName)
  const ownPath = join(tmpdir(), ownName)

  test("removes aged dirs from dead pids; keeps fresh dirs and this process's dirs", async () => {
    await mkdir(stalePath, { recursive: true })
    await writeFile(join(stalePath, '001-you-search.md'), 'residue')
    await mkdir(freshPath, { recursive: true })
    await mkdir(ownPath, { recursive: true })
    try {
      // Age only the stale dir beyond the 24h threshold.
      await agePath(stalePath, 25 * 60 * 60 * 1000)
      await sweepStaleDumpDirs()
      expect(await pathExists(stalePath)).toBe(false)
      expect(await pathExists(freshPath)).toBe(true)
      expect(await pathExists(ownPath)).toBe(true)
    } finally {
      await rm(stalePath, { recursive: true, force: true })
      await rm(freshPath, { recursive: true, force: true })
      await rm(ownPath, { recursive: true, force: true })
    }
  })
})

describe('result text formats (model-facing contract)', () => {
  test('extraction success: names the dump path, chunk count, and re-inspection recipe', () => {
    const text = formatExtractionSuccess('/tmp/dumps/001-you-search.md', 42_000, 1, 'the facts', false)
    expect(text).toContain('/tmp/dumps/001-you-search.md')
    expect(text).toContain('42000 chars')
    expect(text).toContain('grep-dump')
    expect(text).toContain('read-dump')
    expect(text.endsWith('the facts')).toBe(true)
    // Oversize-truncated inputs must not pass silently.
    const flagged = formatExtractionSuccess('/tmp/d.md', 3_000_000, 8, 'partial', true)
    expect(flagged).toContain('partially extracted')
  })

  test('extraction fallback: leads with the failure and dump pointer, then raw text', () => {
    const text = formatExtractionFallback('/tmp/d.md', 50_000, 'provider 500', 'RAWBODY')
    expect(text.indexOf('provider 500')).toBeLessThan(text.indexOf('RAWBODY'))
    expect(text).toContain('50000 chars')
    expect(text).toContain('grep-dump')
    expect(text.endsWith('RAWBODY')).toBe(true)
  })
})

describe('narrowToGoal (hybrid grep: scaffold narrows, one sub-call extracts)', () => {
  const region = (pad: number, phrase: string) => `${'x'.repeat(pad)}${phrase}${'y'.repeat(pad)}`

  test('returns goal-matching regions within budget, dropping unmatched filler', () => {
    const text = `${region(20_000, 'the card was released in 2009')}${region(20_000, 'totally unrelated filler')}${region(20_000, 'printed at uncommon rarity')}`
    const goal = 'When was the card released and what rarity did it have?'
    const narrowed = narrowToGoal(text, goal, 50_000)
    expect(narrowed).toBeDefined()
    expect(narrowed?.text).toContain('released in 2009')
    expect(narrowed?.text).toContain('uncommon rarity')
    expect(narrowed?.text).not.toContain('totally unrelated filler')
    expect((narrowed?.text ?? '').length).toBeLessThanOrEqual(50_000)
    expect(narrowed?.matchedRegions).toBe(2)
  })

  test('merges nearby matches into one region and marks cuts between disjoint regions', () => {
    const text = `${region(500, 'released 2009')}${region(300, 'uncommon rarity')}${region(20_000, 'released 2015')}`
    const goal = 'card release years and rarities'
    const narrowed = narrowToGoal(text, goal, 50_000)
    // First two matches are within one window: no cut between them — both
    // appear before the first region separator.
    expect(narrowed?.text).toContain('released 2009')
    expect(narrowed?.text).toContain('uncommon rarity')
    const mergedText = narrowed?.text ?? ''
    expect(mergedText.indexOf('released 2009')).toBeLessThan(mergedText.indexOf('[…]'))
    expect(mergedText.indexOf('uncommon rarity')).toBeLessThan(mergedText.indexOf('[…]'))
    expect(narrowed?.matchedRegions).toBe(2)
  })

  test('no term matches → undefined (caller falls back to chunk+map)', () => {
    expect(narrowToGoal('plain text about weather', 'quantum chromodynamics loop', 10_000)).toBeUndefined()
  })

  test('goal with no usable terms → undefined', () => {
    expect(narrowToGoal('some text', 'a an the of and', 10_000)).toBeUndefined()
  })

  test('budget cap: many matches truncate to the earliest regions, still under budget', () => {
    const text = Array.from({ length: 40 }, (_, i) => `${region(1_000, `artifact ${i}`)}`).join('')
    const narrowed = narrowToGoal(text, 'artifact inventory', 20_000)
    expect(narrowed?.text.length).toBeLessThanOrEqual(20_000)
    expect(narrowed?.text).toContain('artifact 0')
  })
})

describe('extraction contract (structured sub-call output)', () => {
  const contract = JSON.stringify({
    facts: ['Fact one.', 'Fact two.'],
    goal_status: 'partially_satisfied',
    unresolved_gaps: ['exact year'],
    confidence: 0.6,
  })

  test('accepts a bare JSON contract', () => {
    const parsed = parseExtractionContract(contract)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.contract.facts).toEqual(['Fact one.', 'Fact two.'])
      expect(parsed.contract.goal_status).toBe('partially_satisfied')
      expect(parsed.contract.confidence).toBe(0.6)
    }
  })

  test('accepts fenced and prose-wrapped JSON (model tics)', () => {
    const fenced = '```json\n' + contract + '\n```'
    expect(parseExtractionContract(fenced).ok).toBe(true)
    const wrapped = `Here is the extraction:\n${contract}\nDone.`
    expect(parseExtractionContract(wrapped).ok).toBe(true)
  })

  test('empty facts is valid only with goal_status not_found', () => {
    const notFound = JSON.stringify({
      facts: [],
      goal_status: 'not_found',
      unresolved_gaps: ['nothing here'],
      confidence: 0.9,
    })
    expect(parseExtractionContract(notFound).ok).toBe(true)
    const emptySatisfied = JSON.stringify({ facts: [], goal_status: 'satisfied', unresolved_gaps: [], confidence: 0.9 })
    expect(parseExtractionContract(emptySatisfied).ok).toBe(false)
  })

  test('rejects invalid goal_status, bad confidence, and non-object output', () => {
    expect(parseExtractionContract(JSON.stringify({ facts: ['f'], goal_status: 'done', confidence: 0.5 })).ok).toBe(
      false,
    )
    expect(parseExtractionContract(JSON.stringify({ facts: ['f'], goal_status: 'satisfied', confidence: 3 })).ok).toBe(
      false,
    )
    expect(parseExtractionContract('no json here at all').ok).toBe(false)
    expect(parseExtractionContract('["just", "an array"]').ok).toBe(false)
  })
})

describe('formatStructuredExtraction (root-facing contract render)', () => {
  const c = {
    facts: ['Fact one.', 'Fact two.'],
    goal_status: 'partially_satisfied' as const,
    unresolved_gaps: ['exact year'],
    confidence: 0.6,
  }

  test('renders status line, facts, and the gap-steering recipe', () => {
    const text = formatStructuredExtraction(c)
    expect(text).toContain('partially_satisfied')
    expect(text).toContain('0.60')
    expect(text).toContain('- Fact one.')
    expect(text).toContain('- Fact two.')
    expect(text).toContain('exact year')
    expect(text).toContain('refining a query toward a gap')
  })

  test('omits the gap note when there are no gaps', () => {
    const text = formatStructuredExtraction({ ...c, unresolved_gaps: [] })
    expect(text).toContain('- Fact one.')
    expect(text).not.toContain('refine')
  })

  test('not_found renders explicitly', () => {
    const text = formatStructuredExtraction({
      facts: [],
      goal_status: 'not_found',
      unresolved_gaps: ['nothing'],
      confidence: 0.9,
    })
    expect(text).toContain('not_found')
    expect(text).toContain('No facts')
    expect(text).toContain('nothing')
  })
})

describe('full_page steering (tool_call hook contract)', () => {
  test('blocks only you-search calls that request full_page extraction', () => {
    expect(isFullPageSearch('you-search', { extraction: 'full_page' })).toBe(true)
    expect(isFullPageSearch('you-search', { extraction: 'highlights' })).toBe(false)
    expect(isFullPageSearch('you-search', {})).toBe(false)
    expect(isFullPageSearch('you-contents', { extraction: 'full_page' })).toBe(false)
    expect(isFullPageSearch('you-search', null)).toBe(false)
  })

  test('steering note: positive identify→extract recipe, no capability-denial wording', () => {
    const note = FULL_PAGE_STEERING_NOTE
    expect(note).toContain('you-contents')
    expect(note).toContain('you-search')
    expect(note).toContain('URL')
    expect(note).toContain('refine')
    expect(note.toLowerCase()).not.toContain('not supported')
  })
})
