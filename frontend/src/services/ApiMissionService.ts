import type { MissionService } from './MissionService'
import type { Mission, MissionState, PublicEsimInfo, UsageEvent, WizardData } from '../types/mission'

const BASE_URL = '/api'
const STORAGE_KEY = 'astroam:realMissionState'

function getAuthHeaders(): Record<string, string> {
  const token = sessionStorage.getItem('astroam_token')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

export type Capabilities = {
  backendAvailable: boolean
  network: string
  stage: number
  channelConfigured: boolean
  voucherAgentAvailable: boolean
  cosmoPayStatus: 'live' | 'mock' | 'unavailable'
  citrusStatus: 'live' | 'unavailable'
  connectivityProvider: 'fake' | 'citrus'
  demoTrafficEnabled: boolean
  mode: 'live' | 'partial' | 'demo'
  liveEnabled: boolean
  requiresAuth: boolean
}

export class ApiMissionService implements MissionService {
  constructor() {
    this.loadFromStorage()
  }

  private loadFromStorage(): MissionState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return { mission: null, events: [] }
      return JSON.parse(raw) as MissionState
    } catch {
      return { mission: null, events: [] }
    }
  }

  private saveToStorage(state: MissionState): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  async fetchCapabilities(): Promise<Capabilities | null> {
    try {
      const res = await fetch(`${BASE_URL}/capabilities`)
      if (!res.ok) return null
      return (await res.json()) as Capabilities
    } catch {
      return null
    }
  }

  async createMission(data: WizardData): Promise<Mission> {
    if (!data.destination) throw new Error('No destination selected')

    // 1. POST /api/missions
    const createRes = await fetch(`${BASE_URL}/missions`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        userId: 'usr_demo',
        destination: data.destination,
        startDate: data.startDate,
        endDate: data.endDate,
        budgetUsdc: data.budgetUsdc,
        dailyLimitUsdc: data.dailyLimitUsdc,
        autoPause: data.autoPauseAtLimit,
        lowBalanceAlert: data.alertAt20pct,
      }),
    })

    if (!createRes.ok) {
      const err = await createRes.json()
      throw new Error(err.message || 'Error al crear la misión en la API')
    }

    const { id: missionId } = (await createRes.json()) as { id: string }

    // 2. Create Payment Intent
    const intentRes = await fetch(`${BASE_URL}/missions/${missionId}/payment-intent`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })

    if (!intentRes.ok) {
      const err = await intentRes.json()
      throw new Error(err.message || 'Error al generar intención de pago CosmoPay')
    }

    const intent = (await intentRes.json()) as { intentId: string; isMock: boolean }

    // 3. Confirm Payment (Auto-confirm for demo/mock or real txHash)
    const txHash = intent.isMock
      ? `0xreal_cosmopay_${Date.now().toString(16)}`
      : `0xreal_tx_${Date.now().toString(16)}`

    const confirmRes = await fetch(`${BASE_URL}/missions/${missionId}/payment-confirmation`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ intentId: intent.intentId, txHash }),
    })

    if (!confirmRes.ok) {
      const err = await confirmRes.json()
      throw new Error(err.message || 'Error al confirmar pago')
    }

    // 4. Activate Mission
    const activateRes = await fetch(`${BASE_URL}/missions/${missionId}/activate`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })

    if (!activateRes.ok) {
      const err = await activateRes.json()
      throw new Error(err.message || 'Error al activar misión')
    }

    const activeData = (await activateRes.json()) as {
      missionId: string
      status: string
      isMock?: boolean
      esim?: PublicEsimInfo
    }

    const mission: Mission = {
      id: missionId,
      origin: 'Argentina',
      destination: data.destination,
      startDate: data.startDate,
      endDate: data.endDate,
      durationDays: Math.max(1, Math.ceil((new Date(data.endDate).getTime() - new Date(data.startDate).getTime()) / (1000 * 3600 * 24))),
      budgetUsdc: data.budgetUsdc,
      dailyLimitUsdc: data.dailyLimitUsdc,
      alertAt20pct: data.alertAt20pct,
      autoPauseAtLimit: data.autoPauseAtLimit,
      status: 'active',
      balanceUsdc: data.budgetUsdc,
      consumedUsdc: 0,
      consumedMb: 0,
      esimStatus: 'active',
      network: 'stellar:testnet',
      channelId: `SOROBAN-${missionId}`,
      iccid: activeData.esim?.iccid,
      esim: activeData.esim,
      isMock: activeData.isMock,
      createdAt: new Date().toISOString(),
    }

    const state: MissionState = { mission, events: [] }
    this.saveToStorage(state)
    return mission
  }

  loadState(): MissionState {
    return this.loadFromStorage()
  }

  saveState(state: MissionState): void {
    this.saveToStorage(state)
  }

  simulateConsumption(state: MissionState): MissionState {
    const { mission } = state
    if (!mission) return state

    // Trigger async demo-traffic injection if enabled
    void fetch(`${BASE_URL}/missions/${mission.id}/demo-traffic`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ bytes: 500_000 }),
    })

    const mb = 0.5
    const cost = parseFloat((mb * mission.destination.pricePerMbUsdc).toFixed(6))
    const newBalance = Math.max(0, parseFloat((mission.balanceUsdc - cost).toFixed(6)))
    const newConsumedMb = parseFloat((mission.consumedMb + mb).toFixed(2))
    const newConsumedUsdc = parseFloat((mission.consumedUsdc + cost).toFixed(6))

    const event: UsageEvent = {
      id: `ev_${Date.now()}`,
      timestamp: new Date().toISOString(),
      mb,
      amountUsdc: cost,
      status: 'liquidated',
      txId: `real-tx-${Date.now().toString(16)}`,
    }

    const updatedMission: Mission = {
      ...mission,
      balanceUsdc: newBalance,
      consumedUsdc: newConsumedUsdc,
      consumedMb: newConsumedMb,
      esimStatus: newBalance <= 0 ? 'paused' : mission.esimStatus,
      status: newBalance <= 0 ? 'paused' : mission.status,
    }

    const newState: MissionState = {
      mission: updatedMission,
      events: [event, ...state.events],
    }
    this.saveToStorage(newState)
    return newState
  }

  topUp(state: MissionState, amountUsdc: number): MissionState {
    const { mission } = state
    if (!mission) return state

    // Trigger async topup intent & confirmation
    void (async () => {
      try {
        const intentRes = await fetch(`${BASE_URL}/missions/${mission.id}/topups/payment-intent`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ amountUsdc }),
        })
        if (!intentRes.ok) return
        const intent = (await intentRes.json()) as { intentId: string }

        await fetch(`${BASE_URL}/missions/${mission.id}/topups/payment-confirmation`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ intentId: intent.intentId, txHash: `0xtopup_${Date.now()}` }),
        })
      } catch {
        // Fallback
      }
    })()

    const newBalance = parseFloat((mission.balanceUsdc + amountUsdc).toFixed(6))
    const updatedMission: Mission = {
      ...mission,
      balanceUsdc: newBalance,
      budgetUsdc: mission.budgetUsdc + amountUsdc,
      status: mission.status === 'paused' && mission.esimStatus !== 'paused' ? 'active' : mission.status,
      esimStatus: mission.esimStatus === 'disabled' ? 'active' : mission.esimStatus,
    }

    const topupEvent: UsageEvent = {
      id: `top_${Date.now()}`,
      timestamp: new Date().toISOString(),
      mb: 0,
      amountUsdc,
      status: 'liquidated',
      txId: `real-tx-${Date.now().toString(16)}`,
    }

    const newState: MissionState = {
      mission: updatedMission,
      events: [topupEvent, ...state.events],
    }
    this.saveToStorage(newState)
    return newState
  }

  togglePause(state: MissionState): MissionState {
    const { mission } = state
    if (!mission) return state

    const isPaused = mission.esimStatus === 'paused'
    const endpoint = isPaused ? 'resume' : 'pause'

    void fetch(`${BASE_URL}/missions/${mission.id}/${endpoint}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })

    const updatedMission: Mission = {
      ...mission,
      esimStatus: isPaused ? 'active' : 'paused',
      status: isPaused ? 'active' : 'paused',
      esim: mission.esim ? { ...mission.esim, status: isPaused ? 'active' : 'suspended' } : undefined,
    }

    const newState: MissionState = { mission: updatedMission, events: state.events }
    this.saveToStorage(newState)
    return newState
  }

  completeMission(state: MissionState): MissionState {
    const { mission } = state
    if (!mission) return state

    void fetch(`${BASE_URL}/missions/${mission.id}/finish`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })

    const updatedMission: Mission = {
      ...mission,
      status: 'completed',
      esimStatus: 'disabled',
    }

    const newState: MissionState = { mission: updatedMission, events: state.events }
    this.saveToStorage(newState)
    return newState
  }

  resetDemo(): void {
    localStorage.removeItem(STORAGE_KEY)
  }
}
