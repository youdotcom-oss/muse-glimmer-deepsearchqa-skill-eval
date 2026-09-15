import { describe, expect, test } from 'bun:test'
import {
  buildDistillPrompt,
  buildExplorePrompt,
  buildQueryRepeatNote,
  EXPLORE_JSON_SCHEMA,
  EXTRACTION_JSON_SCHEMA,
  FULL_PAGE_STEERING_NOTE,
  formatExtractionFallback,
  formatExtractionSuccess,
  formatSearchSections,
  formatStructuredExtraction,
  isEmptySearchResult,
  isFullPageSearch,
  normalizeQuery,
  parseExtractionContract,
  QueryDeduper,
  queriesSimilar,
  RLM_CONFIG,
  runGrep,
  sliceByLines,
  validateExploreAction,
} from '../src/rlm.ts'

describe('RLM_CONFIG (fixed constants, no env knobs)', () => {
  test('fixed constants: window boundary at ~2 chars/token web density + explore-loop caps', () => {
    // Measured in the smoke: web content is ~2 chars/token (52k tokens ≈ 100k chars),
    // so 300k chars ≈ 150k tokens — over the 131,072 window. 200k chars ≈ 100k tokens.
    expect(RLM_CONFIG.chunkChars).toBe(200_000)
    expect(RLM_CONFIG.maxGrepRounds).toBe(3)
    expect(RLM_CONFIG.grepMaxMatches).toBe(50)
    expect(RLM_CONFIG.grepFeedbackChars).toBe(4_000)
    expect(RLM_CONFIG.maxSubQueries).toBe(4)
  })

  test('extraction schema: strict JSON schema with required verdict + advisory targets', () => {
    expect(EXTRACTION_JSON_SCHEMA.type).toBe('object')
    expect(EXTRACTION_JSON_SCHEMA.additionalProperties).toBe(false)
    const required = EXTRACTION_JSON_SCHEMA.required as readonly string[]
    for (const key of ['facts', 'goal_status', 'unresolved_gaps', 'confidence', 'sufficient', 'targets']) {
      expect(required).toContain(key)
    }
    const props = EXTRACTION_JSON_SCHEMA.properties as Record<string, { maxItems?: number } | undefined>
    expect(props.facts?.maxItems).toBe(10)
    expect(props.targets?.maxItems).toBe(3)
  })
})

describe('parseExtractionContract (thin trust-boundary validator over schema output)', () => {
  const valid = {
    facts: ['Fact one.', 'Fact two.'],
    goal_status: 'partially_satisfied',
    unresolved_gaps: ['exact year'],
    confidence: 0.6,
    sufficient: false,
    targets: [{ url: 'https://x.gov/report', extract: 'Find the 2019 table.' }],
  }

  test('accepts a schema-conformant contract, including advisory verdict fields', () => {
    const parsed = parseExtractionContract(valid)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.contract.facts).toEqual(['Fact one.', 'Fact two.'])
      expect(parsed.contract.goal_status).toBe('partially_satisfied')
      expect(parsed.contract.confidence).toBe(0.6)
      expect(parsed.contract.sufficient).toBe(false)
      expect(parsed.contract.targets?.[0]?.url).toBe('https://x.gov/report')
      expect(parsed.contract.targets?.[0]?.extract).toBe('Find the 2019 table.')
    }
  })

  test('accepts an empty-targets satisfied verdict and optional suggestion', () => {
    const parsed = parseExtractionContract({
      facts: ['Fact one.'],
      goal_status: 'satisfied',
      unresolved_gaps: [],
      confidence: 0.9,
      sufficient: true,
      targets: [],
      suggestion: 'The full table exists in the linked PDF.',
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.contract.sufficient).toBe(true)
      expect(parsed.contract.targets).toEqual([])
      expect(parsed.contract.suggestion).toBe('The full table exists in the linked PDF.')
    }
  })

  test('empty facts valid only with goal_status not_found', () => {
    const notFound = {
      facts: [],
      goal_status: 'not_found',
      unresolved_gaps: ['x'],
      confidence: 0.5,
      sufficient: true,
      targets: [],
    }
    expect(parseExtractionContract(notFound).ok).toBe(true)
    expect(parseExtractionContract({ ...notFound, goal_status: 'satisfied', facts: [] }).ok).toBe(false)
  })

  test('rejects malformed verdicts and targets at the trust boundary', () => {
    const base = {
      facts: ['f'],
      goal_status: 'satisfied',
      unresolved_gaps: [],
      confidence: 0.5,
      sufficient: true,
      targets: [],
    }
    const t = (url: string) => ({ url, extract: 'look' })
    expect(parseExtractionContract('not an object').ok).toBe(false)
    expect(parseExtractionContract({ ...base, goal_status: 'done' }).ok).toBe(false)
    expect(parseExtractionContract({ ...base, confidence: 3 }).ok).toBe(false)
    expect(parseExtractionContract({ ...base, sufficient: 'false' }).ok).toBe(false)
    expect(parseExtractionContract({ ...base, sufficient: false, targets: [t('a'), t('b'), t('c'), t('d')] }).ok).toBe(
      false,
    )
    expect(parseExtractionContract({ ...base, sufficient: false, targets: [{ extract: 'no url' }] }).ok).toBe(false)
    expect(parseExtractionContract({ ...base, facts: [42] }).ok).toBe(false)
  })
})

describe('validateExploreAction (oversized-doc loop dispatch, schema-enforced)', () => {
  test('accepts grep and distill actions', () => {
    const grep = validateExploreAction({ action: 'grep', pattern: 'suppression units' })
    expect(grep.ok).toBe(true)
    if (grep.ok && grep.action.kind === 'grep') expect(grep.action.pattern).toBe('suppression units')
    const distill = validateExploreAction({ action: 'distill', regions: [{ start_line: 10, end_line: 40 }] })
    expect(distill.ok).toBe(true)
    if (distill.ok && distill.action.kind === 'distill') {
      expect(distill.action.regions).toEqual([{ start_line: 10, end_line: 40 }])
    }
  })

  test('rejects unknown actions, malformed patterns, and out-of-range regions', () => {
    expect(validateExploreAction({ action: 'explode' }).ok).toBe(false)
    expect(validateExploreAction({ action: 'grep', pattern: '' }).ok).toBe(false)
    expect(validateExploreAction({ action: 'grep' }).ok).toBe(false)
    expect(validateExploreAction({ action: 'distill', regions: [] }).ok).toBe(false)
    expect(validateExploreAction({ action: 'distill', regions: [{ start_line: 40, end_line: 10 }] }).ok).toBe(false)
    expect(validateExploreAction({ action: 'distill', regions: [{ start_line: 0, end_line: 5 }] }).ok).toBe(false)
    expect(
      validateExploreAction({
        action: 'distill',
        regions: [
          { start_line: 1, end_line: 5 },
          { start_line: 2, end_line: 6 },
          { start_line: 3, end_line: 7 },
          { start_line: 4, end_line: 8 },
        ],
      }).ok,
    ).toBe(false)
    expect(validateExploreAction('junk').ok).toBe(false)
  })

  test('docLines bound: regions beyond the document reject', () => {
    expect(validateExploreAction({ action: 'distill', regions: [{ start_line: 1, end_line: 50 }] }, 40).ok).toBe(false)
    expect(validateExploreAction({ action: 'distill', regions: [{ start_line: 1, end_line: 40 }] }, 40).ok).toBe(true)
  })

  test('explore schema mirrors the validator: enum action, required pattern/regions', () => {
    expect(EXPLORE_JSON_SCHEMA.properties?.action).toMatchObject({ enum: ['grep', 'distill'] })
  })
})

describe('distill prompts (one user message, no system role, schema carries the shape)', () => {
  const TASK = 'Which fires involved more than 1000 suppression units after 2010?'

  test('search distill: self-contained message with instructions, untrusted-data warning, task, query, results', () => {
    const prompt = buildDistillPrompt({ task: TASK, query: 'san francisco fire database', doc: 'RESULT BODY LINE' })
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain(TASK)
    expect(prompt).toContain('san francisco fire database')
    expect(prompt).toContain('RESULT BODY LINE')
  })

  test('search distill: truncates the overall task to 500 chars', () => {
    const prompt = buildDistillPrompt({ task: 'w'.repeat(700), query: 'q', doc: 'r' })
    expect(prompt).toContain('w'.repeat(500))
    expect(prompt).not.toContain('w'.repeat(501))
  })

  test('explore prompt: doc metadata only (never the oversized doc) plus round feedback', () => {
    const prompt = buildExplorePrompt({
      task: TASK,
      guidance: 'find the post-2010 table',
      round: 2,
      docChars: 915_2741,
      docLines: 120_000,
      feedback: 'line 40213: suppression units 2011 table',
    })
    expect(prompt).toContain('120000')
    expect(prompt).toContain('40213')
    expect(prompt).toContain('find the post-2010 table')
    // The oversized document itself must never ride in the explore prompt.
    expect(prompt.length).toBeLessThan(6_000)
  })
})

describe('sliceByLines (region assembly for the final distill after explore)', () => {
  const doc = Array.from({ length: 100 }, (_, i) => `line ${i + 1}: ${'x'.repeat(20)}`).join('\n')

  test('extracts 1-based inclusive line regions with cut markers between disjoint regions', () => {
    const text = sliceByLines(
      doc,
      [
        { start_line: 2, end_line: 3 },
        { start_line: 50, end_line: 50 },
      ],
      200_000,
    )
    expect(text).toContain('line 2:')
    expect(text).toContain('line 3:')
    expect(text).toContain('line 50:')
    expect(text).not.toContain('line 4:')
    expect(text).not.toContain('line 49:')
    expect(text).toContain('[…]')
  })

  test('budget cap: stops adding regions once the budget is spent; first region always included', () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i + 1}: ${'y'.repeat(200)}`).join('\n')
    const text = sliceByLines(
      big,
      [
        { start_line: 1, end_line: 20 },
        { start_line: 50, end_line: 60 },
      ],
      5_000,
    )
    expect(text.length).toBeLessThanOrEqual(5_500) // first region + marker slack
    expect(text).toContain('line 1:')
    expect(text).not.toContain('line 51:') // second region dropped over budget
  })
})

describe('runGrep (Bun Shell grep over the in-memory document)', () => {
  test('returns numbered matches, capped; literal pattern is injection-safe', async () => {
    const doc = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `needle ${i}` : `filler line ${i}`)).join('\n')
    const out = await runGrep(doc, 'needle', 5)
    expect(out).toContain('1:needle 0')
    expect(out.split('\n').filter((l) => l.includes('needle')).length).toBe(5)
    const none = await runGrep(doc, 'zzz-not-there', 5)
    expect(none).toBe('')
  })
})

describe('formatSearchSections (un-merged per-sub-query render)', () => {
  test('one section per sub-query in input order, contract or prose', () => {
    const text = formatSearchSections([
      {
        query: 'q one',
        contract: {
          facts: ['Fact A.'],
          goal_status: 'satisfied',
          unresolved_gaps: [],
          confidence: 0.9,
          sufficient: true,
          targets: [],
        },
      },
      { query: 'q two', raw: 'RAW FALLBACK BODY' },
    ])
    expect(text).toContain('## "q one"')
    expect(text).toContain('- Fact A.')
    expect(text).toContain('## "q two"')
    expect(text).toContain('RAW FALLBACK BODY')
    expect(text.indexOf('q one')).toBeLessThan(text.indexOf('q two'))
  })

  test('zero-result sections pass the server guidance through verbatim', () => {
    const text = formatSearchSections([{ query: 'q', raw: 'No results found. Try broader terms.' }])
    expect(text).toContain('No results found. Try broader terms.')
  })
})

describe('result text formats (model-facing contract)', () => {
  test('extraction success: names call count and density; internals stay out of root text', () => {
    const text = formatExtractionSuccess(42_000, 1, 'the facts', false)
    expect(text).not.toContain('/tmp/dumps')
    expect(text).not.toContain('.md')
    expect(text).toContain('42000 chars')
    expect(text.endsWith('the facts')).toBe(true)
    const flagged = formatExtractionSuccess(3_000_000, 1, 'partial', true)
    expect(flagged).toContain('partially extracted')
  })

  test('extraction fallback: leads with the failure note, then raw text', () => {
    const text = formatExtractionFallback(50_000, 'no JSON contract', 'RAWBODY')
    expect(text.indexOf('no JSON contract')).toBeLessThan(text.indexOf('RAWBODY'))
    expect(text).toContain('50000 chars')
    expect(text.endsWith('RAWBODY')).toBe(true)
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
    expect(text).toContain('you-contents')
  })

  test('omits the gap note when there are no gaps; not_found renders explicitly', () => {
    const clean = formatStructuredExtraction({ ...c, unresolved_gaps: [] })
    expect(clean).toContain('- Fact one.')
    expect(clean).not.toContain('refine')
    const notFound = formatStructuredExtraction({
      facts: [],
      goal_status: 'not_found',
      unresolved_gaps: ['nothing'],
      confidence: 0.9,
    })
    expect(notFound).toContain('not_found')
    expect(notFound).toContain('No facts')
  })
})

describe('visited_queries dedup (query-thrashing intercept, kept from v3/v7 data)', () => {
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
    expect(deduper.check('').duplicate).toBe(false)
  })

  test('steering note names the repeated query with a refine-or-answer recipe', () => {
    const note = buildQueryRepeatNote('top story on hacker news')
    expect(note).toContain('top story on hacker news')
    expect(note).toContain('refine')
    expect(note).toContain('final answer')
    expect(note.toLowerCase()).not.toContain('not supported')
  })

  test('semantic near-duplicates block even when wording differs', () => {
    expect(
      queriesSimilar(
        'ourworldindata.org age-standardized death rate pancreatic cancer',
        'ourworldindata.org "age-standardized death rate" pancreatic cancer 2014',
      ),
    ).toBe(true)
    expect(queriesSimilar('alpha beta gamma', 'alpha beta delta')).toBe(false)
    const deduper = new QueryDeduper()
    const first = deduper.check('ourworldindata.org "age-standardized death rate" pancreatic cancer 2014')
    expect(first.duplicate).toBe(false)
    const paraphrase = deduper.check('ourworldindata.org age-standardized death rate pancreatic cancer')
    expect(paraphrase.duplicate).toBe(true)
    const different = deduper.check('site:catalogue.data.gov.bc.ca ICBC vehicle population municipality')
    expect(different.duplicate).toBe(false)
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
