/**
 * Retry for transient upstream failures (5xx, network resets) — used by the
 * scaffold's Hugging Face datasets-server pagination, where a single 502 mid-
 * run previously killed a multi-hour eval's scaffold step. Non-transient 4xx
 * responses are returned as-is (no retry).
 */

export interface FetchWithRetryOptions {
  /** Total attempts including the first. Default 5. */
  maxAttempts?: number
  /** Initial backoff in ms (doubles per attempt, clamped). Default 1_000. */
  baseDelayMs?: number
  /** Maximum backoff in ms. Default 30_000. */
  maxDelayMs?: number
  /** Observe backoff delays (tests clamp these). */
  onRetry?: (delayMs: number, attempt: number, status: number) => void
}

const RETRYABLE_STATUS = new Set([502, 503, 504])

function isTransient(response: Response): boolean {
  return RETRYABLE_STATUS.has(response.status)
}

export async function fetchWithRetry(
  attempt: () => Promise<Response>,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 5
  const baseDelay = options.baseDelayMs ?? 1_000
  const maxDelay = options.maxDelayMs ?? 30_000
  for (let index = 1; index <= maxAttempts; index += 1) {
    const response = await attempt()
    if (!isTransient(response) || index === maxAttempts) return response
    const delay = Math.min(baseDelay * 2 ** (index - 1), maxDelay)
    options.onRetry?.(delay, index, response.status)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  // Unreachable: the loop always returns (maxAttempts >= 1).
  throw new Error('unreachable')
}
