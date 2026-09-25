const BASE = '/api'

export type HealthResponse = { status: 'alive' }

export type ReadyResponse =
  | { status: 'ready'; stage: number; checkedAt: string; [key: string]: unknown }
  | { status: 'unavailable'; reason: string; detail: string; stage: number; checkedAt: string }

export async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    return (await res.json()) as HealthResponse
  } catch {
    return null
  }
}

export async function fetchReady(): Promise<ReadyResponse | null> {
  try {
    const res = await fetch(`${BASE}/ready`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok && res.status !== 503) return null
    return (await res.json()) as ReadyResponse
  } catch {
    return null
  }
}
