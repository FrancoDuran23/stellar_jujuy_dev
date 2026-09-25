import type { Mission, MissionState, WizardData } from '../types/mission'

/**
 * Replaceable mission service interface.
 * DemoMissionService implements this today; a real backend adapter
 * will implement the same interface when endpoints exist.
 */
export interface MissionService {
  /** Create and persist a new mission from wizard data */
  createMission(data: WizardData): Promise<Mission>

  /** Load persisted mission state (mission + events) */
  loadState(): MissionState

  /** Save state to persistence layer */
  saveState(state: MissionState): void

  /** Simulate data consumption — updates balance, adds UsageEvent */
  simulateConsumption(state: MissionState): MissionState

  /** Add USDC balance top-up */
  topUp(state: MissionState, amountUsdc: number): MissionState

  /** Pause / resume eSIM */
  togglePause(state: MissionState): MissionState

  /** Mark mission as completed */
  completeMission(state: MissionState): MissionState

  /** Wipe all persisted state (demo reset) */
  resetDemo(): void
}
