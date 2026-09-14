import { describe, expect, test } from 'bun:test'
import { fetchWithRetry } from '../src/http-retry.ts'

describe('fetchWithRetry (transient 5xx resilience for long runs)', () => {
  test('returns the response on 200 without retrying', async () => {
    let attempts = 0
    const response = await fetchWithRetry(async () => {
      attempts += 1
      return new Response('{"ok": true}', { status: 200 })
    })
    expect(response.status).toBe(200)
    expect(attempts).toBe(1)
  })

  test('retries 502/503/504 and succeeds when a later attempt is OK', async () => {
    let attempts = 0
    const delays: number[] = []
    const response = await fetchWithRetry(
      async () => {
        attempts += 1
        if (attempts < 3) return new Response('502 Bad Gateway', { status: 502 })
        return new Response('{"ok": true}', { status: 200 })
      },
      { onRetry: (delayMs) => delays.push(delayMs) },
    )
    expect(response.status).toBe(200)
    expect(attempts).toBe(3)
    // Backoff grows but is clamped short for tests.
    expect(delays.every((d) => d >= 0 && d <= 2_000)).toBe(true)
  })

  test('gives up after maxAttempts and returns the last 5xx response', async () => {
    let attempts = 0
    const response = await fetchWithRetry(
      async () => {
        attempts += 1
        return new Response('502 Bad Gateway', { status: 502 })
      },
      { maxAttempts: 3, onRetry: () => {} },
    )
    expect(attempts).toBe(3)
    expect(response.status).toBe(502)
  })

  test('4xx are not retried (non-transient)', async () => {
    let attempts = 0
    await fetchWithRetry(async () => {
      attempts += 1
      return new Response('forbidden', { status: 403 })
    })
    expect(attempts).toBe(1)
  })
})
