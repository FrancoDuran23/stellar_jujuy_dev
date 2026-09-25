// ── Core domain types for ASTROAM mission flow ──────────────────────────────

export type Network = 'stellar:testnet' | 'stellar:pubnet'

export type MissionStatus = 'active' | 'paused' | 'completed' | 'error'

export type Destination = {
  id: string
  name: string
  flag: string
  network: string
  coverage: string
  pricePerMbUsdc: number
}

export type PublicEsimInfo = {
  iccid: string
  lpaString: string
  qrCode: string
  directInstallUrl: string
  status: string
  isMock?: boolean
}

export type Mission = {
  id: string
  origin: string
  destination: Destination
  startDate: string        // ISO date string (YYYY-MM-DD)
  endDate: string          // ISO date string (YYYY-MM-DD)
  durationDays: number
  budgetUsdc: number       // initial deposit
  dailyLimitUsdc: number
  alertAt20pct: boolean
  autoPauseAtLimit: boolean
  status: MissionStatus
  // live state
  balanceUsdc: number      // remaining
  consumedUsdc: number
  consumedMb: number
  esimStatus: 'active' | 'paused' | 'disabled'
  network: Network
  channelId: string        // mock Soroban channel id
  iccid?: string
  esim?: PublicEsimInfo
  isMock?: boolean
  createdAt: string        // ISO timestamp
}

export type UsageEvent = {
  id: string
  timestamp: string        // ISO timestamp
  mb: number
  amountUsdc: number
  status: 'liquidated'
  txId: string             // abbreviated mock tx hash
  explorerUrl?: string     // filled when real backend available
}

export type PaymentEvent = {
  id: string
  timestamp: string
  type: 'topup' | 'micropayment' | 'refund'
  amountUsdc: number
  description: string
}

export type MissionState = {
  mission: Mission | null
  events: UsageEvent[]
}

// ── Wizard step state ────────────────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3 | 4

export type WizardData = {
  destination: Destination | null
  startDate: string
  endDate: string
  budgetUsdc: number
  dailyLimitUsdc: number
  alertAt20pct: boolean
  autoPauseAtLimit: boolean
}

// ── Activation step type ─────────────────────────────────────────────────────

export type ActivationStep = {
  label: string
  status: 'pending' | 'running' | 'done'
}
