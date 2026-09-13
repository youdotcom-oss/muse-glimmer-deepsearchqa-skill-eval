/**
 * Partner probe repro: measure the raw byte size of you-search responses for
 * a partner-reported intermittent >1MB failure.
 *
 * Context: a partner inference runtime exposes the You.com MCP you-search
 * tool to open-weight models. Their fixed probe prompt ("What is the top story
 * on Hacker News right now?...") fans out into 1-4 model-written sub-queries;
 * they intermittently see a response over 1MB and fail requests at that size.
 *
 * Two measurements, written to PROBE_OUT_DIR (default data/partner-probe):
 *
 * 1. Direct MCP calls with the partner's exact observed sub-queries (plus a
 *    full_page-extraction variant, the leading hypothesis for the blowup).
 *    -> direct-subqueries.jsonl (args, raw response, byte accounting)
 *
 * 2. The exact probe prompt run through our pi agent N times (PROBE_RUNS,
 *    default 5) with you-search as the only tool (matching the partner's
 *    single-tool surface). Measures RAW tool results (our extension truncates
 *    what the model sees, but tool_execution_end carries the raw result — the
 *    same channel the adapter's trajectory records).
 *    -> agent-probes.jsonl (per-run tool calls + byte accounting)
 *
 * Usage:
 *   bun run scripts/partner-probe.ts
 *   MODEL=zai-org/GLM-5.2 PROBE_RUNS=5 bun run scripts/partner-probe.ts
 *
 * Requires YDC_API_KEY (direct calls) and OPENROUTER_API_KEY (agent runs).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CallToolResult, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createPiSession } from '../src/pi-session.ts'

const OUT_DIR = process.env.PROBE_OUT_DIR ?? 'data/partner-probe'
const PROBE_RUNS = Number.parseInt(process.env.PROBE_RUNS ?? '5', 10) || 5
const MODEL = process.env.MODEL ?? 'meta/muse-glimmer-30b'
const MCP_URL = 'https://api.you.com/mcp?tools=you-search,you-contents'

const PROBE_PROMPT =
  'What is the top story on Hacker News right now? You must use the search tool. Answer with the exact title and URL.'

// The partner's observed model-written sub-queries, verbatim from their report.
const PARTNER_SUBQUERIES: Array<Record<string, unknown>> = [
  { query: 'top story on Hacker News front page today', freshness: 'day' },
  { query: 'site:news.ycombinator.com front page top story', freshness: 'day' },
  { query: 'Hacker News front page top post today September 11 2026', freshness: 'day' },
  {
    query: 'top story on Hacker News front page right now',
    freshness: 'day',
    extraction: 'highlights',
    knowledge: 'core',
  },
]

// Hypothesis test: same query, full_page extraction. Our eval run never used
// full_page (32,688 calls, all highlights); if a model requests full_page on a
// sub-query, per-result crawled page content multiplies the response size.
const FULLPAGE_VARIANT: Array<Record<string, unknown>> = [
  { query: 'top story on Hacker News front page today', freshness: 'day', extraction: 'full_page' },
]

export interface ProbeCall {
  tool: string
  query: string
  bytes: number
}

export function accountRun(calls: ProbeCall[]): {
  calls: number
  searchCalls: number
  totalBytes: number
  maxCallBytes: number
} {
  return {
    calls: calls.length,
    searchCalls: calls.filter((c) => c.tool === 'you-search').length,
    totalBytes: calls.reduce((sum, c) => sum + c.bytes, 0),
    maxCallBytes: calls.reduce((max, c) => Math.max(max, c.bytes), 0),
  }
}

function resultBytes(result: CallToolResult): number {
  const textBytes = (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .reduce((sum, b) => sum + Buffer.byteLength(b.text, 'utf-8'), 0)
  const structuredBytes =
    result.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf-8')
  return Math.max(textBytes, structuredBytes)
}

async function directSubqueries(outDir: string): Promise<void> {
  if (!process.env.YDC_API_KEY) throw new Error('YDC_API_KEY is required for direct MCP calls')
  const client = new Client({ name: 'deepsearchqa-partner-probe', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.YDC_API_KEY}` } },
  })
  await client.connect(transport)
  const outPath = join(outDir, 'direct-subqueries.jsonl')
  writeFileSync(outPath, '')
  const targets = [
    ...PARTNER_SUBQUERIES.map((args) => ({ args, label: 'partner-observed' })),
    ...FULLPAGE_VARIANT.map((args) => ({ args, label: 'fullpage-hypothesis' })),
  ]
  for (const { args, label } of targets) {
    const result = (await client.callTool({ name: 'you-search', arguments: args })) as CallToolResult
    const bytes = resultBytes(result)
    const record = {
      label,
      args,
      textBytes: bytes,
      error: Boolean(result.isError),
      raw: result,
      measuredAt: new Date().toISOString(),
    }
    appendFileSync(outPath, `${JSON.stringify(record)}\n`)
    console.error(`[direct] ${label}: ${String(args.query)} -> ${(bytes / 1024).toFixed(1)} KB`)
  }
  await client.close()
}

async function agentProbes(outDir: string): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for agent runs')
  const outPath = join(outDir, 'agent-probes.jsonl')
  writeFileSync(outPath, '')
  for (let run = 1; run <= PROBE_RUNS; run += 1) {
    const skillPath = new URL('../skills/you-web/SKILL.md', import.meta.url).pathname
    const extensionPath = new URL('../src/extension.ts', import.meta.url).pathname
    const { session } = await createPiSession({
      model: MODEL,
      provider: 'openrouter',
      thinkingLevel: 'high',
      tools: ['you-search'], // match the partner's single-tool surface
      systemPrompt: "You are an assistant with web search. Answer the user's question using the search tool.",
      skillPath,
      extensionPath,
    })
    const calls: ProbeCall[] = []
    const startedQueries = new Map<string, string>()
    session.subscribe((event) => {
      const e = event as { type?: string; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown }
      if (e.type === 'tool_execution_start' && e.toolCallId) {
        const args = e.args as { query?: unknown } | undefined
        startedQueries.set(e.toolCallId, typeof args?.query === 'string' ? args.query : '')
      }
      if (e.type === 'tool_execution_end' && e.toolCallId) {
        calls.push({
          tool: e.toolName ?? '',
          query: startedQueries.get(e.toolCallId) ?? '',
          bytes: e.result === undefined ? 0 : Buffer.byteLength(JSON.stringify(e.result), 'utf-8'),
        })
      }
    })
    await session.prompt(PROBE_PROMPT)
    const last = session.messages.at(-1)
    const answer =
      typeof (last as { content?: unknown })?.content === 'string'
        ? (last as { content: string }).content
        : JSON.stringify((last as { content?: unknown })?.content ?? '')
    const account = accountRun(calls)
    const record = {
      run,
      model: MODEL,
      prompt: PROBE_PROMPT,
      calls,
      account,
      answerBytes: Buffer.byteLength(answer, 'utf-8'),
      answerPreview: answer.slice(0, 200),
      measuredAt: new Date().toISOString(),
    }
    appendFileSync(outPath, `${JSON.stringify(record)}\n`)
    console.error(
      `[agent run ${run}] ${account.searchCalls} search call(s), total ${(account.totalBytes / 1024).toFixed(1)} KB, max call ${(account.maxCallBytes / 1024).toFixed(1)} KB`,
    )
    session.dispose()
  }
}

if (import.meta.main) await main()

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  console.error(`=== partner probe repro (model: ${MODEL}, runs: ${PROBE_RUNS}) -> ${OUT_DIR} ===`)
  await directSubqueries(OUT_DIR)
  await agentProbes(OUT_DIR)
  console.error('done')
}

export { agentProbes, directSubqueries }
