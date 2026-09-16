import { type JsonObject, readStdin, writeStdout } from './io.ts'
import {
  collectFinalError,
  collectFinalMessage,
  createPiSession,
  disposePiSession,
  summarizeUsage,
} from './pi-session.ts'
import { estimateYouApiUsage } from './you-cost.ts'

interface AdapterInput {
  task: { prompts: string[] }
  cwd: string
  config?: JsonObject
}

interface TrajectoryEvent extends Record<string, unknown> {
  type: 'message' | 'tool_call' | 'error'
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const HARNESS_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool'])
/** Upstream You.com package (extension + bundled skills), evaluated as a whole. */
const YOU_PI_EXTENSION_PATH = new URL('../node_modules/@youdotcom-oss/pi/main.ts', import.meta.url).pathname
/** The package's web-research skill, passed directly into the system prompt. */
const YOU_PI_WEB_SKILL_PATH = new URL('../node_modules/@youdotcom-oss/pi/skills/you-web/SKILL.md', import.meta.url)
  .pathname
/** No `tools` allowlist: pi enables `read` plus every tool the package registers
 * (you-search, you-contents, you-research, you-finance, you-discover, searchDocs,
 * you-search-free, you-balance). `read` is EXCLUDED: it resolves arbitrary
 * absolute paths and would let the model read data/prompts.jsonl (expected
 * answers), .tmp/generate-tasks.jsonl, and prior graded artifacts. The skill is
 * delivered as system-prompt text instead. The coding tools are excluded so a
 * research trial cannot mutate the working tree. */
const EXCLUDED_TOOLS = ['read', 'bash', 'edit', 'write']
const SYSTEM_PROMPT =
  "You are an autonomous research agent. Answer the user's question using the available tools. " +
  'Ground factual claims in sources, include inline citations, and list sources at the end. Do not ask clarifying questions.'

if (import.meta.main) {
  const input = (await readStdin()) as AdapterInput
  writeStdout(await runAdapter(input))
}

async function runAdapter(input: AdapterInput): Promise<object> {
  const model = String(input.config?.model ?? '')
  if (!model) throw new Error('config.model is required; set the MODEL environment variable when generating.')
  const provider = String(input.config?.provider ?? 'openrouter')
  const thinkingLevel = readThinkingLevel(input.config?.thinkingLevel)
  const prompt = input.task.prompts.join('\n\n')
  const { events, subscribe } = createTrajectoryCollector()

  const { session } = await createPiSession({
    model,
    provider,
    thinkingLevel,
    excludeTools: EXCLUDED_TOOLS,
    systemPrompt: SYSTEM_PROMPT,
    skillPath: YOU_PI_WEB_SKILL_PATH,
    extensionPath: YOU_PI_EXTENSION_PATH,
    cwd: input.cwd,
  })

  session.subscribe(subscribe)
  try {
    await session.prompt(prompt)
    const message = collectFinalMessage(session)
    if (!message) {
      // Surface the provider error (pi attaches errorMessage to the failed
      // assistant turn) so future root-causing reads the graded row, not a repro.
      const finalError = collectFinalError(session)
      const failureMessage = finalError?.errorMessage
        ? `No final assistant response generated. Last turn stopReason=${finalError.stopReason ?? 'unknown'}: ${finalError.errorMessage}`
        : 'No final assistant response generated.'
      return {
        result: {
          status: 'failed',
          message: failureMessage,
          error: failureMessage,
          failureKind: 'harness_error',
        },
        trajectory: events,
        metadata: {
          model,
          provider,
          thinkingLevel,
          usage: summarizeUsage(session.messages),
          youApiUsage: estimateYouApiUsage(events),
        },
      }
    }
    return {
      result: { status: 'completed', message },
      trajectory: events,
      metadata: {
        model,
        provider,
        thinkingLevel,
        usage: summarizeUsage(session.messages),
        youApiUsage: estimateYouApiUsage(events),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      result: { status: 'failed', message: `Adapter error: ${message}`, error: message, failureKind: 'harness_error' },
      trajectory: events,
      metadata: {
        model,
        provider,
        thinkingLevel,
        usage: summarizeUsage(session.messages),
        youApiUsage: estimateYouApiUsage(events),
      },
    }
  } finally {
    await disposePiSession(session)
  }
}

function readThinkingLevel(value: unknown): ThinkingLevel {
  // Defaults to high: the A/B grid showed high thinking lifts avg F1 ~4pp on its
  // own; generate.ts always passes THINKING_LEVEL (default high), so this
  // fallback only fires when the config value is missing or invalid.
  return typeof value === 'string' && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : 'high'
}

function createTrajectoryCollector(): { events: TrajectoryEvent[]; subscribe: (event: unknown) => void } {
  const events: TrajectoryEvent[] = []
  const toolStartedAt = new Map<string, number>()

  function subscribe(event: unknown): void {
    const piEvent = event as { type?: string; [key: string]: unknown }
    const now = Date.now()
    const timestamp = new Date(now).toISOString()
    switch (piEvent.type) {
      case 'tool_execution_start': {
        const toolCallId = String(piEvent.toolCallId ?? '')
        if (toolCallId) toolStartedAt.set(toolCallId, now)
        events.push({
          type: 'tool_call',
          name: String(piEvent.toolName ?? ''),
          status: 'started',
          timestamp,
          input: asObject(piEvent.input ?? piEvent.args),
          metadata: toolCallId ? { toolCallId } : undefined,
        })
        break
      }
      case 'tool_execution_end': {
        const toolCallId = String(piEvent.toolCallId ?? '')
        const startedAt = toolStartedAt.get(toolCallId)
        if (toolCallId) toolStartedAt.delete(toolCallId)
        events.push({
          type: 'tool_call',
          name: String(piEvent.toolName ?? ''),
          status: piEvent.isError ? 'failed' : 'completed',
          timestamp,
          durationMs: numberValue(piEvent.durationMs) ?? (startedAt === undefined ? undefined : now - startedAt),
          output: asObject(piEvent.result),
          metadata: toolCallId ? { toolCallId } : undefined,
        })
        break
      }
      case 'message_end': {
        const message = asObject(piEvent.message)
        events.push({
          type: 'message',
          role: roleFrom(message) ?? 'assistant',
          content: messageContent(message),
          timestamp,
          metadata: messageMetadata(message),
        })
        break
      }
      case 'error':
        events.push({ type: 'error', message: String(piEvent.message ?? 'Unknown error'), timestamp })
        break
    }
  }

  return { events, subscribe }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function roleFrom(message: JsonObject | undefined): string | undefined {
  const role = message?.role
  return normalizeMessageRole(role)
}

export function normalizeMessageRole(role: unknown): 'user' | 'assistant' | 'system' | 'tool' | undefined {
  if (role === 'toolResult') return 'tool'
  return typeof role === 'string' && HARNESS_MESSAGE_ROLES.has(role)
    ? (role as 'user' | 'assistant' | 'system' | 'tool')
    : undefined
}

function messageContent(message: JsonObject | undefined): string {
  const content = message?.content
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

function messageMetadata(message: JsonObject | undefined): JsonObject | undefined {
  if (!message) return undefined
  const metadata: JsonObject = {}
  for (const key of ['api', 'provider', 'model', 'responseModel', 'responseId', 'stopReason']) {
    const value = message[key]
    if (typeof value === 'string') metadata[key] = value
  }
  if (message.usage !== undefined) metadata.usage = message.usage
  return Object.keys(metadata).length ? metadata : undefined
}
