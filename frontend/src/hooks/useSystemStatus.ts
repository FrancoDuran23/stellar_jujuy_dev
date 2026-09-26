import { useEffect, useState } from 'react'
import { fetchHealth, fetchReady } from '../api/system'

type BackendStatus = 'checking' | 'online' | 'offline'

type SystemStatus = {
  backend: BackendStatus
  stage: number | null
  detail: string | null
  isDemo: boolean
}

export function useSystemStatus(): SystemStatus {
  const [status, setStatus] = useState<SystemStatus>({
    backend: 'checking',
    stage: null,
    detail: null,
    isDemo: false,
  })

  useEffect(() => {
    let cancelled = false

    async function check() {
      const [health, ready] = await Promise.all([fetchHealth(), fetchReady()])
      if (cancelled) return

      if (health && ready) {
        setStatus({
          backend: 'online',
          stage: typeof ready.stage === 'number' ? ready.stage : null,
          detail: ready.status === 'unavailable' ? ready.detail ?? null : null,
          isDemo: ready.status !== 'ready',
        })
      } else {
        setStatus({ backend: 'offline', stage: null, detail: null, isDemo: true })
      }
    }

    void check()
    const interval = setInterval(() => void check(), 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return status
}
