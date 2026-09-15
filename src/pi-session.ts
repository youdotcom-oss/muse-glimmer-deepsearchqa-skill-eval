import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { readIntegerEnv, readStringEnv } from './env.ts'

interface CreatePiSessionOptions {
  model: string
  provider: string
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Tool allowlist; omit to enable pi's defaults plus every extension tool. */
  tools?: string[]
  /** Tools to disable after the allowlist/defaults are applied. */
  excludeTools?: string[]
  systemPrompt: string
  /** Optional extra skill path; the @youdotcom-oss/pi package contributes its own
   * skills through `resources_discover`, which bindExtensions runs below. */
  skillPath?: string
  extensionPath: string
  cwd?: string
}

interface PiSessionResult {
  session: Awaited<ReturnType<typeof createAgentSession>>['session']
}

const DEFAULT_PI_PROVIDER_TIMEOUT_MS = 180_000
const DEFAULT_PI_PROVIDER_MAX_RETRIES = 2
const DEFAULT_PI_PROVIDER_MAX_RETRY_DELAY_MS = 60_000

export function createPiSettingsManager(): ReturnType<typeof SettingsManager.inMemory> {
  return SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: {
        timeoutMs: readIntegerEnv('PI_PROVIDER_TIMEOUT_MS', DEFAULT_PI_PROVIDER_TIMEOUT_MS, 1),
        maxRetries: readIntegerEnv('PI_PROVIDER_MAX_RETRIES', DEFAULT_PI_PROVIDER_MAX_RETRIES, 0),
        maxRetryDelayMs: readIntegerEnv('PI_PROVIDER_MAX_RETRY_DELAY_MS', DEFAULT_PI_PROVIDER_MAX_RETRY_DELAY_MS, 1),
      },
    },
  })
}

export async function createPiSession(options: CreatePiSessionOptions): Promise<PiSessionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')

  const modelRuntime = await ModelRuntime.create({
    modelsPath: readStringEnv('MODELS_PATH', new URL('../models.json', import.meta.url).pathname),
  })
  await modelRuntime.setRuntimeApiKey(options.provider, apiKey)

  const model = modelRuntime.getModel(options.provider, options.model)
  if (!model) throw new Error(`Model ${options.provider}/${options.model} not found in pi registry`)

  const settingsManager = createPiSettingsManager()
  const loader = new DefaultResourceLoader({
    cwd: options.cwd ?? process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    additionalSkillPaths: options.skillPath ? [options.skillPath] : [],
    additionalExtensionPaths: [options.extensionPath],
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => options.systemPrompt,
  })
  await loader.reload()

  const { session } = await createAgentSession({
    cwd: options.cwd ?? process.cwd(),
    model,
    thinkingLevel: options.thinkingLevel,
    modelRuntime,
    resourceLoader: loader,
    tools: options.tools,
    excludeTools: options.excludeTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  })

  // The SDK path never fires `session_start`/`resources_discover`: only
  // print/rpc/interactive modes call bindExtensions. @youdotcom-oss/pi publishes
  // its bundled skills through `resources_discover`, so drive the lifecycle.
  await session.bindExtensions({
    mode: 'print',
    onError: (error) => {
      process.stderr.write(`Extension error (${error.extensionPath}): ${String(error.error)}\n`)
    },
  })

  return { session }
}

/** Tear a session down through pi's real lifecycle: emit `session_shutdown`
 * (which the SDK's `dispose()` never does) so extensions release resources —
 * @youdotcom-oss/pi closes its pooled MCP clients there — then dispose.
 * Best-effort: teardown must not mask a trial result. */
export async function disposePiSession(session: PiSessionResult['session']): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  } catch {
    // Teardown is best-effort.
  }
  session.dispose()
}

export function collectFinalMessage(session: PiSessionResult['session']): string {
  const msg = session.messages.at(-1)
  if (msg?.role !== 'assistant') return ''
  return messageContentText((msg as { content?: unknown }).content).trim()
}

/** When the final assistant turn is empty, surface the provider error (pi
 * attaches `errorMessage` to the failed assistant message) so trial failures
 * are diagnosable from the graded artifacts instead of requiring a repro. */
export function collectFinalError(session: PiSessionResult['session']): {
  stopReason: string | undefined
  errorMessage: string | undefined
} | null {
  const msg = session.messages.at(-1)
  if (msg?.role !== 'assistant') return null
  if (messageContentText((msg as { content?: unknown }).content).trim().length > 0) return null
  const record = msg as { stopReason?: unknown; errorMessage?: unknown }
  return {
    stopReason: typeof record.stopReason === 'string' ? record.stopReason : undefined,
    errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : undefined,
  }
}

export function summarizeUsage(messages: unknown[]): Record<string, number> {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 }
  for (const message of messages) {
    const object = asRecord(message)
    if (object?.role !== 'assistant') continue
    const usage = asRecord(object.usage)
    const cost = asRecord(usage?.cost)
    total.inputTokens += numberValue(usage?.input)
    total.outputTokens += numberValue(usage?.output)
    total.cacheReadTokens += numberValue(usage?.cacheRead)
    total.cacheWriteTokens += numberValue(usage?.cacheWrite)
    total.totalTokens += numberValue(usage?.totalTokens)
    total.costUsd += numberValue(cost?.total)
  }
  return total
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : typeof (part as { text?: unknown })?.text === 'string'
          ? (part as { text: string }).text
          : '',
    )
    .join('')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
