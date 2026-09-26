import { useCallback, useEffect, useState } from 'react'
import { envConfig } from '../config/env'
import { demoMissionService } from '../services/DemoMissionService'
import { apiMissionService } from '../services/ApiMissionService'
import type {
  BackendCapabilities,
  FinishResult,
  Mission,
  PaymentConfirmationResult,
  PaymentIntentInfo,
  UsageEvent,
  WizardData,
} from '../types/mission'

export function useMission() {
  const [mission, setMission] = useState<Mission | null>(null)
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [caps, setCaps] = useState<BackendCapabilities | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<boolean>(false)

  const isDemoMode = envConfig.mode === 'demo'

  const loadBackendState = useCallback(async () => {
    setLoading(true)
    setBackendError(null)

    if (isDemoMode) {
      const state = demoMissionService.loadState()
      setMission(state.mission)
      setEvents(state.events)
      setLoading(false)
      return
    }

    // API Mode
    try {
      const capabilities = await apiMissionService.fetchCapabilities()
      setCaps(capabilities)

      if (!capabilities || !capabilities.backendAvailable) {
        setBackendError('BACKEND NO DISPONIBLE — El servidor de producto ASTROAM no responde.')
        setLoading(false)
        return
      }

      const savedId = apiMissionService.getSavedMissionId()
      if (savedId) {
        try {
          const freshMission = await apiMissionService.getMission(savedId)
          setMission(freshMission)
          try {
            const usage = await apiMissionService.getUsage(savedId)
            if (usage) {
              setMission((prev) =>
                prev
                  ? {
                      ...prev,
                      carrierBytes: usage.carrierBytes,
                      meteredBytes: usage.meteredBytes,
                    }
                  : null,
              )
            }
          } catch {
            // Usage poll fail non-fatal
          }
        } catch {
          // Saved mission not found on server
          apiMissionService.clearSavedMissionId()
          setMission(null)
        }
      }
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : 'Error al conectar con la API')
    } finally {
      setLoading(false)
    }
  }, [isDemoMode])

  useEffect(() => {
    void loadBackendState()
  }, [loadBackendState])

  // Polling in API Mode when mission is active
  useEffect(() => {
    if (isDemoMode || !mission || !mission.id) return

    const interval = setInterval(async () => {
      try {
        const fresh = await apiMissionService.getMission(mission.id)
        const usage = await apiMissionService.getUsage(mission.id)
        const meteredBytes = Number(usage.meteredBytes) || 0
        setMission({
          ...fresh,
          consumedMb: meteredBytes > 0 ? Math.round((meteredBytes / (1024 * 1024)) * 100) / 100 : fresh.consumedMb,
        })
      } catch {
        // Polling error non-fatal
      }
    }, 8000)

    return () => clearInterval(interval)
  }, [isDemoMode, mission?.id])

  const createMission = async (data: WizardData): Promise<Mission> => {
    setActionLoading(true)
    try {
      if (isDemoMode) {
        const newMission = await demoMissionService.createMission(data)
        setMission(newMission)
        setEvents([])
        return newMission
      } else {
        const newMission = await apiMissionService.createMission(data)
        setMission(newMission)
        return newMission
      }
    } finally {
      setActionLoading(false)
    }
  }

  const createPaymentIntent = async (): Promise<PaymentIntentInfo> => {
    if (!mission) throw new Error('No hay misión activa')
    if (isDemoMode) {
      return {
        intentId: `intent_demo_${Date.now()}`,
        amount: mission.budgetUsdc.toString(),
        asset: 'USDC',
        status: 'pending',
        isMock: true,
      }
    }
    return apiMissionService.createPaymentIntent(mission.id)
  }

  const confirmPayment = async (intentId: string, txHash: string): Promise<PaymentConfirmationResult> => {
    if (!mission) throw new Error('No hay misión activa')
    setActionLoading(true)
    try {
      if (isDemoMode) {
        const updated: Mission = { ...mission, paymentStatus: 'paid', status: 'paid', depositTxHash: txHash }
        setMission(updated)
        demoMissionService.saveState({ mission: updated, events })
        return { valid: true, status: 'paid', depositTxHash: txHash }
      }
      const res = await apiMissionService.confirmPayment(mission.id, intentId, txHash)
      if (res.valid) {
        const fresh = await apiMissionService.getMission(mission.id)
        setMission(fresh)
      }
      return res
    } finally {
      setActionLoading(false)
    }
  }

  const activate = async (): Promise<void> => {
    if (!mission) throw new Error('No hay misión activa')
    setActionLoading(true)
    try {
      if (isDemoMode) {
        const updated: Mission = { ...mission, status: 'active', esimStatus: 'active' }
        setMission(updated)
        demoMissionService.saveState({ mission: updated, events })
        return
      }
      const res = await apiMissionService.activateMission(mission.id)
      const fresh = await apiMissionService.getMission(mission.id)
      setMission({
        ...fresh,
        esim: res.esim || fresh.esim,
        isMock: res.isMock ?? fresh.isMock,
      })
    } finally {
      setActionLoading(false)
    }
  }

  const createTopUpIntent = async (amountUsdc: number): Promise<PaymentIntentInfo> => {
    if (!mission) throw new Error('No hay misión activa')
    if (isDemoMode) {
      return {
        intentId: `top_intent_${Date.now()}`,
        amount: amountUsdc.toString(),
        asset: 'USDC',
        status: 'pending',
        isMock: true,
      }
    }
    return apiMissionService.createTopUpIntent(mission.id, amountUsdc)
  }

  const confirmTopUpPayment = async (intentId: string, txHash: string, amountUsdc: number): Promise<void> => {
    if (!mission) throw new Error('No hay misión activa')
    setActionLoading(true)
    try {
      if (isDemoMode) {
        const newState = demoMissionService.topUp({ mission, events }, amountUsdc)
        setMission(newState.mission)
        setEvents(newState.events)
        return
      }
      await apiMissionService.confirmTopUpPayment(mission.id, intentId, txHash)
      const fresh = await apiMissionService.getMission(mission.id)
      setMission(fresh)
    } finally {
      setActionLoading(false)
    }
  }

  const togglePause = async (): Promise<void> => {
    if (!mission) return
    setActionLoading(true)
    try {
      if (isDemoMode) {
        const newState = demoMissionService.togglePause({ mission, events })
        setMission(newState.mission)
        setEvents(newState.events)
        return
      }
      const isPaused = mission.esimStatus === 'paused'
      if (isPaused) {
        await apiMissionService.resumeMission(mission.id)
      } else {
        await apiMissionService.pauseMission(mission.id)
      }
      const fresh = await apiMissionService.getMission(mission.id)
      setMission(fresh)
    } finally {
      setActionLoading(false)
    }
  }

  const finish = async (): Promise<FinishResult> => {
    if (!mission) throw new Error('No hay misión activa')
    setActionLoading(true)
    try {
      if (isDemoMode) {
        const newState = demoMissionService.completeMission({ mission, events })
        setMission(newState.mission)
        setEvents(newState.events)
        return { status: 'completed', txHash: '0xdemo_close_tx' }
      }
      const res = await apiMissionService.finishMission(mission.id)
      const fresh = await apiMissionService.getMission(mission.id)
      setMission(fresh)
      return res
    } finally {
      setActionLoading(false)
    }
  }

  const simulate = async (): Promise<void> => {
    if (!mission) return
    if (isDemoMode) {
      const newState = demoMissionService.simulateConsumption({ mission, events })
      setMission(newState.mission)
      setEvents(newState.events)
    } else {
      await apiMissionService.triggerDemoTraffic(mission.id, 500_000)
      const fresh = await apiMissionService.getMission(mission.id)
      setMission(fresh)
    }
  }

  const reset = (): void => {
    if (isDemoMode) {
      demoMissionService.resetDemo()
    } else {
      apiMissionService.clearSavedMissionId()
    }
    setMission(null)
    setEvents([])
  }

  return {
    mission,
    events,
    caps,
    loading,
    actionLoading,
    backendError,
    isDemoMode,
    retryBackend: loadBackendState,
    createMission,
    createPaymentIntent,
    confirmPayment,
    activate,
    createTopUpIntent,
    confirmTopUpPayment,
    togglePause,
    finish,
    simulate,
    reset,
  }
}
