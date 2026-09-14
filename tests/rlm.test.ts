import { describe, expect, test } from 'bun:test'
import {
  buildDefaultGoal,
  buildQueryRepeatNote,
  buildSearchDistillPrompt,
  buildTargetDistillPrompt,
  collateContracts,
  FULL_PAGE_STEERING_NOTE,
  formatExtractionFallback,
  formatExtractionSuccess,
  formatStructuredExtraction,
  isEmptySearchResult,
  isFullPageSearch,
  narrowToGoal,
  normalizeQuery,
  parseContentsResponse,
  parseExtractionContract,
  QueryDeduper,
  queriesSimilar,
  RLM_CONFIG,
} from '../src/rlm.ts'

describe('RLM_CONFIG (fixed constants, no env knobs)', () => {
  test('fixed constants: chunk boundary fits muse 131k window at measured ~2 chars/token web density', () => {
    // Measured in the smoke: web content is ~2 chars/token (52k tokens ≈ 100k chars),
    // so 300k chars ≈ 150k tokens — over the 131,072 window. 200k chars ≈ 100k tokens.
    expect(RLM_CONFIG.chunkChars).toBe(200_000)
  })

  test('sub-call output is capped (latency: sub-calls are output-bound, ~230 tok/s)', () => {
    // 1,800: headroom above the 10-fact cap — smoke 2 showed 1,500 truncated
    // 18% of contracts mid-JSON (dense fact lists with URLs at ~2 chars/token).
    expect(RLM_CONFIG.maxOutputTokens).toBe(1_800)
    // The prompt bounds the array so the cap truncates rarely, and carries the
    // same instruction so the model stops before the cap.
    expect(buildSearchDistillPrompt({ task: 't', query: 'q', rawResults: 'r' })).toMatch(/max 10/i)
  })
})

describe('buildDefaultGoal (question-aware distillation goal)', () => {
  test('composes the research question into the goal so the sub-model can filter for relevance', () => {
    const goal = buildDefaultGoal(
      'List the fires from the San Francisco database involving more than 1000 suppression units after 2010.',
    )
    expect(goal).toContain('San Francisco database')
    expect(goal).toContain('research question')
    expect(goal).toContain('facts')
  })

  test('truncates long questions and flattens newlines', () => {
    const long = Array.from({ length: 60 }, () => 'word').join(' ') + '\n\nsecond paragraph with\nnewlines'
    const goal = buildDefaultGoal(long)
    expect(goal.length).toBeLessThan(800)
    expect(goal).not.toContain('\n')
  })

  test('no question captured: falls back to the generic goal', () => {
    const goal = buildDefaultGoal(undefined)
    expect(goal).toContain('research question')
    expect(goal).not.toContain('undefined')
  })
})

describe('result text formats (model-facing contract)', () => {
  test('extraction success: names chunk count and density; dump path is internal-only', () => {
    const text = formatExtractionSuccess(42_000, 1, 'the facts', false)
    // Dump paths must never reach the root model: no read/grep tools exist, and
    // the sampled trials showed paths leaking into final answers as citations.
    expect(text).not.toContain('/tmp/dumps')
    expect(text).not.toContain('.md')
    expect(text).toContain('42000 chars')
    expect(text.endsWith('the facts')).toBe(true)
    // Oversize-truncated inputs must not pass silently.
    const flagged = formatExtractionSuccess(3_000_000, 8, 'partial', true)
    expect(flagged).toContain('partially extracted')
  })

  test('extraction fallback: leads with the failure note, then raw text; dump path internal-only', () => {
    const text = formatExtractionFallback(50_000, 'provider 500', 'RAWBODY')
    expect(text.indexOf('provider 500')).toBeLessThan(text.indexOf('RAWBODY'))
    expect(text).toContain('50000 chars')
    expect(text).not.toContain('/tmp/d.md')
    expect(text).not.toContain('grep-dump')
    expect(text.endsWith('RAWBODY')).toBe(true)
  })
})

describe('stage-1/stage-2 distill prompts (one user message, no system role)', () => {
  const TASK = 'Which fires involved more than 1000 suppression units after 2010?'

  test('search distill: single self-contained message with instructions, JSON shape, verdict semantics, task, query, results', () => {
    const prompt = buildSearchDistillPrompt({
      task: TASK,
      query: 'san francisco fire database suppression units',
      rawResults: 'RESULT BODY LINE',
    })
    // Self-contained: worker instructions + JSON shape ride in the same
    // message — there is no system role in a v7 sub-call.
    expect(prompt).toContain('ONLY with')
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain('"sufficient"')
    expect(prompt).toContain('"targets"')
    expect(prompt).toMatch(/max 10/i)
    expect(prompt).toContain('no document reads')
    expect(prompt).toContain(TASK)
    expect(prompt).toContain('san francisco fire database suppression units')
    expect(prompt).toContain('RESULT BODY LINE')
  })

  test('search distill: truncates the overall task to 500 chars', () => {
    const prompt = buildSearchDistillPrompt({ task: 'w'.repeat(700), query: 'q', rawResults: 'r' })
    expect(prompt).toContain('w'.repeat(500))
    expect(prompt).not.toContain('w'.repeat(501))
  })

  test('target distill: embeds task, original query, the stage-1 extract guidance, and the document', () => {
    const prompt = buildTargetDistillPrompt({
      task: TASK,
      query: 'san francisco fire database suppression units',
      guidance: 'Find the table of post-2010 fires with over 1000 suppression units.',
      doc: 'DOCUMENT BODY',
    })
    expect(prompt).toContain('ONLY with')
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain(TASK)
    expect(prompt).toContain('san francisco fire database suppression units')
    expect(prompt).toContain('Find the table of post-2010 fires with over 1000 suppression units.')
    expect(prompt).toContain('DOCUMENT BODY')
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

  test('optional suggestion field parses and is preserved', () => {
    const parsed = parseExtractionContract(
      JSON.stringify({
        facts: ['Fact one.'],
        goal_status: 'not_found',
        unresolved_gaps: ['table data'],
        confidence: 0.4,
        suggestion: 'The full table exists in the linked PDF; search for an HTML version of the report.',
      }),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.contract.suggestion).toBe(
        'The full table exists in the linked PDF; search for an HTML version of the report.',
      )
    }
  })

  test('missing suggestion is fine (optional field)', () => {
    const parsed = parseExtractionContract(
      JSON.stringify({ facts: ['Fact one.'], goal_status: 'satisfied', unresolved_gaps: [], confidence: 0.9 }),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.contract.suggestion).toBeUndefined()
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

  test('salvages a truncated contract: recovers complete facts, marks partial', () => {
    // Output-cap truncation cut the JSON after three complete facts.
    const truncated = '{"facts": ["Fact one about the 2019 report.", "Fact two with URL https://x.gov/a", "Fact th'
    const parsed = parseExtractionContract(truncated)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.contract.facts).toEqual(['Fact one about the 2019 report.', 'Fact two with URL https://x.gov/a'])
      expect(parsed.contract.goal_status).toBe('partially_satisfied')
      expect(parsed.contract.confidence).toBeLessThan(1)
    }
  })

  test('truncation before any complete fact falls back to prose (ok:false)', () => {
    expect(parseExtractionContract('{"facts": ["cut mid str').ok).toBe(false)
  })

  test('v7 verdict: parses sufficient + targets; absent sufficient defaults to true (backward compat)', () => {
    const parsed = parseExtractionContract(
      JSON.stringify({
        facts: ['Fact one.'],
        goal_status: 'partially_satisfied',
        unresolved_gaps: ['exact year'],
        confidence: 0.6,
        sufficient: false,
        targets: [{ url: 'https://x.gov/report', extract: 'Find the 2019 suppression-unit table.' }],
      }),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.contract.sufficient).toBe(false)
      expect(parsed.contract.targets).toEqual([
        { url: 'https://x.gov/report', extract: 'Find the 2019 suppression-unit table.' },
      ])
    }
    const legacy = parseExtractionContract(
      JSON.stringify({ facts: ['Fact one.'], goal_status: 'satisfied', unresolved_gaps: [], confidence: 0.9 }),
    )
    expect(legacy.ok).toBe(true)
    if (legacy.ok) {
      expect(legacy.contract.sufficient).toBe(true)
      expect(legacy.contract.targets).toEqual([])
    }
  })

  test('v7 verdict validation: >3 targets, malformed entries, and non-boolean sufficient reject', () => {
    const base = { facts: ['f'], goal_status: 'partially_satisfied', unresolved_gaps: [], confidence: 0.5 }
    const t = (url: string) => ({ url, extract: 'look' })
    expect(
      parseExtractionContract(JSON.stringify({ ...base, sufficient: false, targets: [t('a'), t('b'), t('c'), t('d')] }))
        .ok,
    ).toBe(false)
    expect(
      parseExtractionContract(JSON.stringify({ ...base, sufficient: false, targets: [{ url: 'https://x' }] })).ok,
    ).toBe(false)
    expect(
      parseExtractionContract(JSON.stringify({ ...base, sufficient: false, targets: [{ extract: 'no url' }] })).ok,
    ).toBe(false)
    expect(parseExtractionContract(JSON.stringify({ ...base, sufficient: 'false' })).ok).toBe(false)
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

describe('collateContracts (sufficiency gate: deeper stage-2 read collates over stage-1)', () => {
  test('stage-2 facts first (deduped vs stage-1), gap union, worst stage-2 status, min stage-2 confidence', () => {
    const stage1 = {
      facts: ['Shared fact.', 'Snippet fact.'],
      goal_status: 'partially_satisfied' as const,
      unresolved_gaps: ['gap one', 'gap two'],
      confidence: 0.8,
    }
    const stage2 = [
      {
        facts: ['Deep fact A.', 'shared FACT.'],
        goal_status: 'satisfied' as const,
        unresolved_gaps: ['gap two', 'gap three'],
        confidence: 0.9,
      },
      { facts: ['Deep fact B.'], goal_status: 'not_found' as const, unresolved_gaps: [], confidence: 0.3 },
    ]
    const merged = collateContracts(stage1, stage2)
    // Stage-2 facts lead; the stage-1 near-duplicate of a stage-2 fact is dropped.
    expect(merged.facts.slice(0, 3)).toEqual(['Deep fact A.', 'shared FACT.', 'Deep fact B.'])
    expect(merged.facts).toContain('Snippet fact.')
    expect(merged.facts).not.toContain('Shared fact.')
    expect(merged.goal_status).toBe('not_found') // worst of stage-2
    expect(merged.confidence).toBe(0.3) // min of stage-2
    expect(merged.unresolved_gaps).toEqual(['gap one', 'gap two', 'gap three'])
  })

  test('caps and ordering: facts cap 12 (stage-2 first), gaps cap 6 (stage-1 first)', () => {
    const stage1 = {
      facts: Array.from({ length: 10 }, (_, i) => `s1 fact ${i}`),
      goal_status: 'satisfied' as const,
      unresolved_gaps: Array.from({ length: 5 }, (_, i) => `gap ${i}`),
      confidence: 0.9,
    }
    const stage2 = [
      {
        facts: Array.from({ length: 10 }, (_, i) => `s2 fact ${i}`),
        goal_status: 'partially_satisfied' as const,
        unresolved_gaps: Array.from({ length: 5 }, (_, i) => `gap ${i + 3}`),
        confidence: 0.7,
      },
    ]
    const merged = collateContracts(stage1, stage2)
    expect(merged.facts.length).toBe(12)
    expect(merged.facts[0]).toBe('s2 fact 0')
    expect(merged.unresolved_gaps.length).toBe(6)
    expect(merged.unresolved_gaps[0]).toBe('gap 0')
  })

  test('no usable stage-2 contracts: stage-1 stands unchanged', () => {
    const stage1 = {
      facts: ['Fact one.'],
      goal_status: 'satisfied' as const,
      unresolved_gaps: [],
      confidence: 0.8,
      suggestion: 'try the PDF',
    }
    const merged = collateContracts(stage1, [])
    expect(merged.facts).toEqual(['Fact one.'])
    expect(merged.goal_status).toBe('satisfied')
    expect(merged.confidence).toBe(0.8)
    expect(merged.suggestion).toBe('try the PDF')
  })
})

describe('parseContentsResponse (internal stage-2 fetch → per-URL documents)', () => {
  const docs = [
    { url: 'https://a.example/x', title: 'A', markdown: 'Doc A body', metadata: {} },
    { url: 'https://b.example/y', title: 'B', markdown: 'Doc B body', metadata: {} },
  ]

  test('reads structuredContent.output first, then the JSON text block; drops malformed entries', () => {
    expect(parseContentsResponse({ output: docs }, 'unused text')).toEqual([
      { url: 'https://a.example/x', markdown: 'Doc A body' },
      { url: 'https://b.example/y', markdown: 'Doc B body' },
    ])
    expect(parseContentsResponse(undefined, JSON.stringify({ output: docs })).length).toBe(2)
    // Trust boundary: entries without a string url or non-empty markdown are
    // dropped, never passed into a sub-call.
    expect(
      parseContentsResponse(
        {
          output: [
            { url: 'https://a' },
            { url: 'https://b', markdown: '' },
            'junk',
            { url: 'https://c', markdown: 'ok' },
          ],
        },
        '',
      ),
    ).toEqual([{ url: 'https://c', markdown: 'ok' }])
    expect(parseContentsResponse(undefined, 'not json at all')).toEqual([])
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
    // Gap notes carry the contents escalation: highlights often lack the data.
    expect(text).toContain('you-contents')
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

describe('visited_queries dedup (query-thrashing intercept)', () => {
  test('normalizes case and whitespace', () => {
    expect(normalizeQuery('  Top Story   on Hacker News ')).toBe('top story on hacker news')
  })

  test('first query passes; exact repeat in any casing/spacing blocks; distinct query passes', () => {
    const deduper = new QueryDeduper()
    expect(deduper.check('Top story on HN').duplicate).toBe(false)
    expect(deduper.check('top story on hn').duplicate).toBe(true)
    expect(deduper.check('  TOP STORY ON HN  ').duplicate).toBe(true)
    expect(deduper.check('different query entirely').duplicate).toBe(false)
  })

  test('empty or whitespace queries never block', () => {
    const deduper = new QueryDeduper()
    expect(deduper.check('').duplicate).toBe(false)
    expect(deduper.check('   ').duplicate).toBe(false)
    // ...and are not recorded as seen.
    expect(deduper.check('').duplicate).toBe(false)
  })

  test('steering note names the repeated query with a refine-or-answer recipe', () => {
    const note = buildQueryRepeatNote('top story on hacker news')
    expect(note).toContain('top story on hacker news')
    expect(note).toContain('refine')
    expect(note).toContain('final answer')
    expect(note.toLowerCase()).not.toContain('not supported')
  })
})

describe('zero-result passthrough (server guidance must reach the root)', () => {
  test('detects an empty result set from the structured MCP response', () => {
    expect(isEmptySearchResult({ results: { web: [], news: [] } })).toBe(true)
    expect(isEmptySearchResult({ results: {} })).toBe(true)
    expect(isEmptySearchResult(undefined)).toBe(true)
    expect(isEmptySearchResult({ results: { web: [{ url: 'https://x' }], news: [], knowledge: [] } })).toBe(false)
  })
})

describe('semantic query dedup (paraphrase thrash)', () => {
  test('near-identical paraphrases block even when wording differs', () => {
    // Direct threshold check: 5/6 shared tokens = 0.83 Jaccard.
    expect(
      queriesSimilar(
        'ourworldindata.org age-standardized death rate pancreatic cancer',
        'ourworldindata.org "age-standardized death rate" pancreatic cancer 2014',
      ),
    ).toBe(true)
    expect(queriesSimilar('alpha beta gamma', 'alpha beta delta')).toBe(false) // 3/5 < 0.8
    const deduper = new QueryDeduper()
    const first = deduper.check('ourworldindata.org "age-standardized death rate" pancreatic cancer 2014')
    expect(first.duplicate).toBe(false)
    const paraphrase = deduper.check('ourworldindata.org age-standardized death rate pancreatic cancer')
    expect(paraphrase.duplicate).toBe(true)
    // A genuinely different facet passes.
    const different = deduper.check('site:catalogue.data.gov.bc.ca ICBC vehicle population municipality')
    expect(different.duplicate).toBe(false)
  })

  test('short queries only match on high overlap; small facets stay distinct', () => {
    const deduper = new QueryDeduper()
    expect(deduper.check('Surrey ICBC passenger vehicles').duplicate).toBe(false)
    // 3/4 tokens shared but only 4 tokens total — below the distinct-facet bar? No:
    // 3/4 overlap is high; a different municipality is a different facet though.
    const different = deduper.check('Langley ICBC passenger vehicles')
    expect(different.duplicate).toBe(false)
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
