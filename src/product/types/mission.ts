export type DestinationInfo = {
  id: string
  name: string
  flag: string
  network: string
  coverage: string
  pricePerMbUsdc: number
}

export type ProductMissionStatus =
  | 'pending_payment'
  | 'paid'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'

export type TopUpRecord = {
  id: string
  intentId: string
  amountUsdc: number
  txHash?: string
  status: 'pending' | 'settled'
  createdAt: string
}

export type PublicEsimInfo = {
  iccid: string
  lpaString: string
  qrCode: string
  directInstallUrl: string
  status: string
  isMock?: boolean
}

export type ProductMission = {
  id: string
  userId: string
  destination: DestinationInfo
  startDate: string
  endDate: string
  durationDays: number
  budgetUsdc: number
  dailyLimitUsdc: number
  autoPause: boolean
  lowBalanceAlert: boolean
  status: ProductMissionStatus
  paymentStatus: 'pending' | 'paid' | 'failed'
  paymentIntentId?: string
  depositTxHash?: string
  channelId?: string
  iccid?: string
  esim?: PublicEsimInfo
  esimStatus: 'active' | 'paused' | 'disabled' | 'not_provisioned'
  meteredBytes: string // string representation of bigint
  carrierBytes: string // string representation of bigint
  balanceUsdc: number
  consumedUsdc: number
  consumedMb: number
  topups: TopUpRecord[]
  closeTxHash?: string
  createdAt: string
  updatedAt: string
}

export type Capabilities = {
  backendAvailable: boolean
  network: string
  stage: number
  channelConfigured: boolean
  voucherAgentAvailable: boolean
  paymentServerReady: boolean
  voucherAgentReady: boolean
  channelReady: boolean
  citrusReady: boolean
  connectivityProvider: 'fake' | 'citrus'
  cosmoPayStatus: 'live' | 'mock' | 'unavailable'
  cosmoPayMode: 'live' | 'mock' | 'unavailable'
  citrusStatus: 'live' | 'unavailable'
  meteringMode: 'real' | 'demo' | 'unavailable'
  reconciliationAvailable: boolean
  demoTrafficEnabled: boolean
  mode: 'live' | 'partial' | 'demo'
  liveEnabled: boolean
  requiresAuth: boolean
  missingConfiguration: string[]
}
