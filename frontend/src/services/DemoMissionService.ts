/**
 * DemoMissionService
 *
 * Fully isolated demo adapter that implements MissionService.
 * All state lives in localStorage under STORAGE_KEY.
 * No network calls — safe to use without a running backend.
 *
 * Uses Citrus Mobile demo representations.
 */
import type { MissionService } from './MissionService'
import type { Mission, MissionState, PublicEsimInfo, UsageEvent, WizardData } from '../types/mission'
import {
  randomHex,
  daysBetween,
  STELLAR_NETWORK,
} from '../utils/missionUtils'

const STORAGE_KEY = 'astroam:missionState'

// MB consumed per simulated click
const CONSUME_MB_STEP = 0.5

function emptyState(): MissionState {
  return { mission: null, events: [] }
}

function load(): MissionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    return JSON.parse(raw) as MissionState
  } catch {
    return emptyState()
  }
}

function save(state: MissionState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export const demoMissionService: MissionService = {
  createMission(data: WizardData): Promise<Mission> {
    if (!data.destination) return Promise.reject(new Error('No destination selected'))

    const iccid = `fake_${randomHex(4)}`
    const mockEsim: PublicEsimInfo = {
      iccid,
      lpaString: `LPA:1$rsp.citrusmobile.demo$DEMO_${data.destination.id.toUpperCase()}_${Date.now()}`,
      qrCode: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="%230F172A" rx="16"/><rect x="20" y="20" width="40" height="40" fill="%236941FF"/><rect x="140" y="20" width="40" height="40" fill="%236941FF"/><rect x="20" y="140" width="40" height="40" fill="%236941FF"/><rect x="80" y="80" width="40" height="40" fill="%2300F0FF"/><text x="100" y="180" fill="%2394A3B8" font-size="10" font-family="sans-serif" text-anchor="middle">CITRUS SIMULADO</text></svg>`,
      directInstallUrl: `https://citrusmobile.com/install-demo?iccid=${iccid}`,
      status: 'active',
      isMock: true,
    }

    const mission: Mission = {
      id: randomHex(16),
      origin: 'Argentina',
      destination: data.destination,
      startDate: data.startDate,
      endDate: data.endDate,
      durationDays: daysBetween(data.startDate, data.endDate),
      budgetUsdc: data.budgetUsdc,
      dailyLimitUsdc: data.dailyLimitUsdc,
      alertAt20pct: data.alertAt20pct,
      autoPauseAtLimit: data.autoPauseAtLimit,
      status: 'active',
      balanceUsdc: data.budgetUsdc,
      consumedUsdc: 0,
      consumedMb: 0,
      esimStatus: 'active',
      network: STELLAR_NETWORK,
      channelId: `SOROBAN-MOCK-${randomHex(8).toUpperCase()}`,
      iccid,
      esim: mockEsim,
      isMock: true,
      createdAt: new Date().toISOString(),
    }

    const state: MissionState = { mission, events: [] }
    save(state)
    return Promise.resolve(mission)
  },

  loadState(): MissionState {
    return load()
  },

  saveState(state: MissionState): void {
    save(state)
  },

  simulateConsumption(state: MissionState): MissionState {
    const { mission, events } = state
    if (!mission || mission.status !== 'active' || mission.esimStatus !== 'active') {
      return state
    }

    const mb = CONSUME_MB_STEP
    const cost = parseFloat((mb * mission.destination.pricePerMbUsdc).toFixed(6))
    const newBalance = Math.max(0, parseFloat((mission.balanceUsdc - cost).toFixed(6)))
    const newConsumedMb = parseFloat((mission.consumedMb + mb).toFixed(2))
    const newConsumedUsdc = parseFloat((mission.consumedUsdc + cost).toFixed(6))

    const event: UsageEvent = {
      id: randomHex(8),
      timestamp: new Date().toISOString(),
      mb,
      amountUsdc: cost,
      status: 'liquidated',
      txId: `sim-tx-${randomHex(16)}`,
    }

    const updatedMission: Mission = {
      ...mission,
      balanceUsdc: newBalance,
      consumedUsdc: newConsumedUsdc,
      consumedMb: newConsumedMb,
      // auto-pause when budget hits 0
      esimStatus: newBalance <= 0 ? 'paused' : mission.esimStatus,
      status: newBalance <= 0 ? 'paused' : mission.status,
    }

    const newState: MissionState = {
      mission: updatedMission,
      events: [event, ...events],
    }
    save(newState)
    return newState
  },

  topUp(state: MissionState, amountUsdc: number): MissionState {
    const { mission, events } = state
    if (!mission) return state

    const newBalance = parseFloat((mission.balanceUsdc + amountUsdc).toFixed(6))
    const updatedMission: Mission = {
      ...mission,
      balanceUsdc: newBalance,
      budgetUsdc: mission.budgetUsdc + amountUsdc,
      // re-activate if was paused due to zero balance
      status: mission.status === 'paused' && mission.esimStatus !== 'paused' ? 'active' : mission.status,
      esimStatus: mission.esimStatus === 'disabled' ? 'active' : mission.esimStatus,
    }

    const topupEvent: UsageEvent = {
      id: randomHex(8),
      timestamp: new Date().toISOString(),
      mb: 0,
      amountUsdc,
      status: 'liquidated',
      txId: `sim-tx-${randomHex(16)}`,
    }

    const newState: MissionState = {
      mission: updatedMission,
      events: [topupEvent, ...events],
    }
    save(newState)
    return newState
  },

  togglePause(state: MissionState): MissionState {
    const { mission, events } = state
    if (!mission) return state

    const isPaused = mission.esimStatus === 'paused'
    const updatedMission: Mission = {
      ...mission,
      esimStatus: isPaused ? 'active' : 'paused',
      status: isPaused ? 'active' : 'paused',
      esim: mission.esim ? { ...mission.esim, status: isPaused ? 'active' : 'suspended' } : undefined,
    }

    const newState: MissionState = { mission: updatedMission, events }
    save(newState)
    return newState
  },

  completeMission(state: MissionState): MissionState {
    const { mission, events } = state
    if (!mission) return state

    const updatedMission: Mission = {
      ...mission,
      status: 'completed',
      esimStatus: 'disabled',
    }

    const newState: MissionState = { mission: updatedMission, events }
    save(newState)
    return newState
  },

  resetDemo(): void {
    localStorage.removeItem(STORAGE_KEY)
  },
}
