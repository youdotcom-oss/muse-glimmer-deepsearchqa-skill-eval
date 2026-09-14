/**
 * Knowledge-parameter probe: replay failed factual queries against the
 * you-search MCP endpoint with knowledge: "core" and measure whether the
 * licensed-knowledge node ever returns content. Motivated by the full-run
 * finding: 25 knowledge-param attempts in 2,700 trials, 24 blocked pre-exec,
 * the 1 executed call returned {"results":{}} — 0 knowledge nodes in 37.5k
 * completed searches. This probe isolates the parameter from agent noise.
 *
 * Usage: bun run scripts/knowledge-probe.ts [samplePath]
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const MCP_URL = 'https://api.you.com/mcp?tools=you-search'
const SAMPLE_PATH = process.argv[2] ?? '/tmp/knowledge-probe-sample.tsv'
const PAUSE_MS = 500

interface SampleRow {
  task: string
  query: string
}

async function main(): Promise<void> {
  const apiKey = process.env.YDC_API_KEY
  if (!apiKey) throw new Error('YDC_API_KEY is not set')

  const raw = (await Bun.file(SAMPLE_PATH).text()).trim().split('\n').slice(1)
  const samples: SampleRow[] = raw
    .map((line) => {
      const [task, ...rest] = line.split('\t')
      return { task: task.trim(), query: rest.join('\t').trim() }
    })
    .filter((s) => s.query.length > 0)

  console.log(`probing ${samples.length} failed factual queries with knowledge: "core"...\n`)

  const client = new Client({ name: 'knowledge-probe', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }),
  )

  let withKnowledgeNode = 0
  let knowledgeItems = 0
  let webResults = 0
  let emptyResults = 0
  const outcomes: Array<{ query: string; kNode: number; web: number; news: number }> = []

  for (const [index, sample] of samples.entries()) {
    const result = (await client.callTool({
      name: 'you-search',
      arguments: { query: sample.query, knowledge: 'core' },
    })) as {
      structuredContent?: { results?: { web?: unknown[]; news?: unknown[]; knowledge?: unknown[] } }
      isError?: boolean
    }
    if (result.isError) {
      outcomes.push({ query: sample.query, kNode: -1, web: -1, news: -1 })
      console.log(`${String(index + 1).padStart(2)}) ERROR  ${sample.query.slice(0, 70)}`)
      continue
    }
    const results = result.structuredContent?.results ?? {}
    const web = results.web?.length ?? 0
    const news = results.news?.length ?? 0
    const knowledge = results.knowledge?.length ?? 0
    if (knowledge > 0) withKnowledgeNode++
    knowledgeItems += knowledge
    webResults += web
    if (web === 0 && news === 0 && knowledge === 0) emptyResults++
    outcomes.push({ query: sample.query, kNode: knowledge, web, news })
    console.log(
      `${String(index + 1).padStart(2)}) web:${String(web).padStart(3)} news:${String(news).padStart(3)} knowledge:${knowledge} | ${sample.query.slice(0, 70)}`,
    )
    if (knowledge > 0) {
      for (const k of (results.knowledge ?? []).slice(0, 1)) {
        console.log(`      knowledge: ${JSON.stringify(k).slice(0, 220)}`)
      }
    }
    await Bun.sleep(PAUSE_MS)
  }

  await client.close()
  console.log('\n=== SUMMARY ===')
  console.log(`queries probed:            ${samples.length}`)
  console.log(`returned knowledge node:   ${withKnowledgeNode}`)
  console.log(`total knowledge items:     ${knowledgeItems}`)
  console.log(`returned web results:      ${webResults} (avg ${(webResults / samples.length).toFixed(1)}/query)`)
  console.log(`completely empty:          ${emptyResults}`)
}

await main()
