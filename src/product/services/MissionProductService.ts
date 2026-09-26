import type { CosmoPayService } from '../../services/CosmoPayService.ts'
import type { ConnectivityProvider } from '../../providers/connectivity/ConnectivityProvider.ts'
import type { MissionRepository } from '../persistence/MissionRepository.ts'
import type { Capabilities, DestinationInfo, ProductMission, PublicEsimInfo } from '../types/mission.ts'
import { IntegratedMeterService } from '../../meter/meter-service.ts'
import type { ChannelBalancePort } from '../../services/PolicyEnforcer.ts'
import type { VoucherPort } from '../../meter/voucher-port.ts'
import type { ChannelPort } from '../../agent/channel.ts'
import { createConnectivitySession, type ConnectivitySession } from '../../models/ConnectivitySession.ts'
import { runReconciliation } from '../../jobs/reconciliation.ts'
import type { Network } from '../../shared/stellar/network.ts'
import { pricePerMibFromPerMbRaw } from '../../shared/money.ts'

export type MissionProductServiceOptions = {
  repo: MissionRepository
  cosmoPay: CosmoPayService
  connectivity?: ConnectivityProvider
  citrus?: ConnectivityProvider
  telnyx?: ConnectivityProvider
  voucherPort?: VoucherPort
  balancePort?: ChannelBalancePort
  channelPort?: ChannelPort
  hasCitrusReal?: boolean
  hasTelnyxReal?: boolean
  hasChannelReal?: boolean
  hasVoucherAgentReal?: boolean
  network?: Network
}

export class MissionProductService {
  private repo: MissionRepository
  private cosmoPay: CosmoPayService
  private connectivity: ConnectivityProvider
  private voucherPort?: VoucherPort
  private balancePort?: ChannelBalancePort
  private channelPort?: ChannelPort
  private hasCitrusReal: boolean
  private hasChannelReal: boolean
  private hasVoucherAgentReal: boolean
  private network: Network

  // Active sessions & meter services per mission
  private sessions = new Map<string, ConnectivitySession>()
  private meters = new Map<string, IntegratedMeterService>()

  constructor(options: MissionProductServiceOptions) {
    this.repo = options.repo
    this.cosmoPay = options.cosmoPay
    const conn = options.connectivity || options.citrus || options.telnyx
    if (!conn) {
      throw new Error('ConnectivityProvider es requerido en MissionProductServiceOptions')
    }
    this.connectivity = conn
    this.voucherPort = options.voucherPort
    this.balancePort = options.balancePort
    this.channelPort = options.channelPort
    this.hasCitrusReal = options.hasCitrusReal ?? options.hasTelnyxReal ?? false
    this.hasChannelReal = options.hasChannelReal ?? false
    this.hasVoucherAgentReal = options.hasVoucherAgentReal ?? false
    this.network = options.network ?? 'stellar:testnet'
  }

  private isLiveMode(): boolean {
    return process.env.ASTROAM_LIVE_ENABLED === 'true'
  }

  private getMissingConfiguration(): string[] {
    const missing: string[] = []
    if (!process.env.COSMOS_PAY_API_KEY) missing.push('COSMOS_PAY_API_KEY')
    if (!process.env.CITRUS_API_KEY) missing.push('CITRUS_API_KEY')
    if (!process.env.PRICE_PER_MB_RAW && !process.env.TELNYX_PRICE_PER_MB_USDC) missing.push('PRICE_PER_MB_RAW')
    if (!process.env.CHANNEL_CONTRACT) missing.push('CHANNEL_CONTRACT')
    if (!process.env.AGENT_VOUCHERS_URL) missing.push('AGENT_VOUCHERS_URL')
    if (!process.env.GATEWAY_TOKEN) missing.push('GATEWAY_TOKEN')
    if (this.isLiveMode()) {
      if (!process.env.ASTROAM_DEMO_ACCESS_TOKEN) missing.push('ASTROAM_DEMO_ACCESS_TOKEN')
      if (!process.env.FRONTEND_ORIGIN || process.env.FRONTEND_ORIGIN === '*') missing.push('FRONTEND_ORIGIN')
    }
    return missing
  }

  async getCapabilities(): Promise<Capabilities> {
    const isLive = this.isLiveMode()
    const missing = this.getMissingConfiguration()

    let voucherAgentReady = false
    const agentUrl = process.env.AGENT_VOUCHERS_URL
    if (agentUrl && this.hasVoucherAgentReal) {
      try {
        const baseUrl = agentUrl.replace(/\/vouchers\/?$/, '')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1500)
        const res = await fetch(`${baseUrl}/ready`, { signal: controller.signal })
        clearTimeout(timer)
        if (res.ok) {
          const body = (await res.json()) as { status?: string }
          voucherAgentReady = body.status === 'ready'
        }
      } catch {
        voucherAgentReady = false
      }
    }

    const channelConfigured = Boolean(process.env.CHANNEL_CONTRACT)
    const citrusReady = this.hasCitrusReal
    const channelReady = this.hasChannelReal
    const cosmoPayStatus: Capabilities['cosmoPayStatus'] = this.cosmoPay.isMock
      ? (isLive ? 'unavailable' : 'mock')
      : 'live'

    let meteringMode: Capabilities['meteringMode'] = 'demo'
    if (isLive) {
      if (voucherAgentReady && channelReady && citrusReady) {
        meteringMode = 'real'
      } else {
        meteringMode = 'unavailable'
      }
    } else {
      meteringMode = 'demo'
    }

    let mode: Capabilities['mode'] = 'demo'
    if (isLive) {
      if (cosmoPayStatus === 'live' && citrusReady && channelReady && voucherAgentReady) {
        mode = 'live'
      } else if (cosmoPayStatus === 'live' || citrusReady || channelReady || voucherAgentReady) {
        mode = 'partial'
      } else {
        mode = 'demo'
      }
    }

    return {
      backendAvailable: true,
      network: this.network,
      stage: channelConfigured ? 2 : 1,
      channelConfigured,
      voucherAgentAvailable: voucherAgentReady,
      paymentServerReady: true,
      voucherAgentReady,
      channelReady,
      citrusReady,
      connectivityProvider: this.hasCitrusReal ? 'citrus' : 'fake',
      cosmoPayStatus,
      cosmoPayMode: cosmoPayStatus,
      citrusStatus: citrusReady ? 'live' : 'unavailable',
      meteringMode,
      reconciliationAvailable: citrusReady,
      demoTrafficEnabled: process.env.ENABLE_DEMO_TRAFFIC === 'true',
      mode,
      liveEnabled: isLive,
      requiresAuth: isLive && Boolean(process.env.ASTROAM_DEMO_ACCESS_TOKEN),
      missingConfiguration: missing,
    }
  }

  async createMission(payload: {
    userId?: string
    destination: DestinationInfo
    startDate: string
    endDate: string
    budgetUsdc: number
    dailyLimitUsdc: number
    autoPause?: boolean
    lowBalanceAlert?: boolean
  }): Promise<{ id: string; status: string }> {
    const id = `mis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const start = new Date(payload.startDate)
    const end = new Date(payload.endDate)
    const diffTime = Math.abs(end.getTime() - start.getTime())
    const durationDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)))

    const mission: ProductMission = {
      id,
      userId: payload.userId || 'usr_demo',
      destination: payload.destination,
      startDate: payload.startDate,
      endDate: payload.endDate,
      durationDays,
      budgetUsdc: payload.budgetUsdc,
      dailyLimitUsdc: payload.dailyLimitUsdc,
      autoPause: payload.autoPause ?? true,
      lowBalanceAlert: payload.lowBalanceAlert ?? true,
      status: 'pending_payment',
      paymentStatus: 'pending',
      esimStatus: 'not_provisioned',
      meteredBytes: '0',
      carrierBytes: '0',
      balanceUsdc: payload.budgetUsdc,
      consumedUsdc: 0,
      consumedMb: 0,
      topups: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await this.repo.save(mission)
    return { id: mission.id, status: mission.status }
  }

  async createPaymentIntent(missionId: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (this.isLiveMode() && this.cosmoPay.isMock) {
      const err = new Error('503: Servicio CosmoPay no disponible en modo live (falta COSMOS_PAY_API_KEY)')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    const intent = await this.cosmoPay.createDepositIntent({
      amount: mission.budgetUsdc.toString(),
      msg: `ASTROAM Mision ${mission.id}`,
    })

    mission.paymentIntentId = intent.id
    await this.repo.save(mission)

    return {
      intentId: intent.id,
      amount: intent.amount,
      asset: intent.asset,
      sep7Uri: intent.uri,
      qr: intent.qr,
      destination: intent.destination,
      status: intent.status,
      isMock: intent.isMock,
    }
  }

  async confirmPayment(missionId: string, intentId: string, txHash: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (mission.paymentStatus === 'paid' && mission.depositTxHash) {
      return { valid: true, status: 'paid', depositTxHash: mission.depositTxHash }
    }

    if (this.isLiveMode() && this.cosmoPay.isMock) {
      const err = new Error('503: Servicio CosmoPay no disponible en modo live')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    const result = await this.cosmoPay.validateTx(intentId, txHash)
    if (!result.valid) {
      mission.paymentStatus = 'failed'
      await this.repo.save(mission)
      throw new Error(`Pago inválido para la intención ${intentId}: ${result.status}`)
    }

    mission.paymentStatus = 'paid'
    mission.status = 'paid'
    mission.depositTxHash = txHash
    await this.repo.save(mission)

    return { valid: true, status: 'paid', depositTxHash: txHash }
  }

  async activateMission(missionId: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (mission.paymentStatus !== 'paid') {
      throw new Error('No se puede activar una misión cuyo pago no ha sido validado')
    }

    if (this.isLiveMode() && !this.hasCitrusReal) {
      const err = new Error('503: Servicio Citrus Mobile no disponible en modo live (falta CITRUS_API_KEY)')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    // Idempotent check
    if (mission.status === 'active' && mission.iccid && mission.esim) {
      return {
        missionId: mission.id,
        status: mission.status,
        isMock: !this.hasCitrusReal,
        esim: mission.esim,
      }
    }

    const esimRecord = await this.connectivity.provisionEsim(mission.userId)
    const channelId = mission.channelId || process.env.CHANNEL_CONTRACT || `SOROBAN-CHANNEL-${Date.now().toString(16).toUpperCase()}`

    const publicEsim: PublicEsimInfo = {
      iccid: esimRecord.iccid,
      lpaString: esimRecord.lpaString,
      qrCode: esimRecord.qrCode,
      directInstallUrl: esimRecord.directInstallUrl,
      status: esimRecord.status,
      isMock: !this.hasCitrusReal,
    }

    mission.iccid = esimRecord.iccid
    mission.esim = publicEsim
    mission.channelId = channelId
    mission.status = 'active'
    mission.esimStatus = 'active'

    // Create session
    const session = createConnectivitySession({
      id: `ses_${mission.id}`,
      userId: mission.userId,
      iccid: esimRecord.iccid,
      channelId,
    })
    this.sessions.set(mission.id, session)

    await this.repo.save(mission)

    return {
      missionId: mission.id,
      status: 'active',
      isMock: !this.hasCitrusReal,
      esim: publicEsim,
    }
  }

  async getMission(missionId: string): Promise<ProductMission> {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)
    return mission
  }

  async getUsage(missionId: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    let session = this.sessions.get(missionId)
    if (!session && mission.iccid) {
      session = createConnectivitySession({
        id: `ses_${mission.id}`,
        userId: mission.userId,
        iccid: mission.iccid,
        channelId: mission.channelId || 'channel_unknown',
      })
      this.sessions.set(missionId, session)
    }

    if (!session || !mission.iccid) {
      return {
        chargedMicroUsd: '0',
        walletMicroUsd: '0',
        providerStatus: 'not_provisioned',
        meteredBytes: mission.meteredBytes,
        carrierBytes: '0',
        differenceBytes: mission.meteredBytes,
        isEstimation: true,
        note: 'Estimación contable basada en tarifa en USDC',
      }
    }

    const recon = await runReconciliation(session, { provider: this.connectivity })
    const usage = await this.connectivity.getUsage(mission.iccid)

    return {
      chargedMicroUsd: recon.chargedMicroUsd.toString(),
      tripChargedMicroUsd: recon.tripChargedMicroUsd.toString(),
      walletMicroUsd: recon.walletMicroUsd.toString(),
      providerStatus: usage.status,
      meteredBytes: mission.meteredBytes,
      carrierBytes: mission.carrierBytes,
      differenceBytes: (BigInt(mission.meteredBytes) - BigInt(mission.carrierBytes)).toString(),
      isEstimation: true,
      note: 'Estimación contable basada en tarifa en USDC',
    }
  }

  async pauseMission(missionId: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (this.isLiveMode() && !this.hasCitrusReal) {
      const err = new Error('503: Servicio Citrus Mobile no disponible en modo live')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    if (mission.iccid) {
      await this.connectivity.suspend(mission.iccid)
    }

    mission.esimStatus = 'paused'
    mission.status = 'paused'
    if (mission.esim) {
      mission.esim.status = 'suspended'
    }
    await this.repo.save(mission)

    return { status: 'paused', esimStatus: 'paused' }
  }

  async resumeMission(missionId: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (this.isLiveMode() && !this.hasCitrusReal) {
      const err = new Error('503: Servicio Citrus Mobile no disponible en modo live')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    if (mission.iccid) {
      await this.connectivity.resume(mission.iccid)
    }

    mission.esimStatus = 'active'
    mission.status = 'active'
    if (mission.esim) {
      mission.esim.status = 'active'
    }
    await this.repo.save(mission)

    return { status: 'active', esimStatus: 'active' }
  }

  async createTopUpIntent(missionId: string, amountUsdc: number) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (this.isLiveMode() && this.cosmoPay.isMock) {
      const err = new Error('503: Servicio CosmoPay no disponible en modo live')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    const intent = await this.cosmoPay.createDepositIntent({
      amount: amountUsdc.toString(),
      msg: `ASTROAM Recarga ${missionId}`,
    })

    const record = {
      id: `top_${Date.now()}`,
      intentId: intent.id,
      amountUsdc,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }

    mission.topups.push(record)
    await this.repo.save(mission)

    return {
      intentId: intent.id,
      amount: intent.amount,
      asset: intent.asset,
      sep7Uri: intent.uri,
      qr: intent.qr,
      status: intent.status,
      isMock: intent.isMock,
    }
  }

  async confirmTopUpPayment(missionId: string, intentId: string, txHash: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    const topup = mission.topups.find((t) => t.intentId === intentId)
    if (!topup) throw new Error(`Recarga con intención ${intentId} no encontrada`)

    if (topup.status === 'settled' && topup.txHash) {
      return { valid: true, status: 'settled', txHash: topup.txHash }
    }

    if (this.isLiveMode() && this.cosmoPay.isMock) {
      const err = new Error('503: Servicio CosmoPay no disponible en modo live')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    const result = await this.cosmoPay.validateTx(intentId, txHash)
    if (!result.valid) {
      throw new Error(`Pago de recarga inválido: ${result.status}`)
    }

    if (this.channelPort?.topUp && mission.channelId) {
      try {
        const rawAmount = BigInt(Math.round(topup.amountUsdc * 1e7))
        await this.channelPort.topUp({ channel: mission.channelId, amountRaw: rawAmount })
      } catch {
        // Fallback
      }
    }

    if (mission.iccid) {
      try {
        const amountCents = Math.max(1, Math.round(topup.amountUsdc * 100))
        await this.connectivity.topUp(mission.iccid, amountCents)
      } catch {
        // Safe fallback
      }
    }

    topup.status = 'settled'
    topup.txHash = txHash
    mission.balanceUsdc += topup.amountUsdc
    mission.budgetUsdc += topup.amountUsdc
    if (mission.status === 'paused' && mission.balanceUsdc > 0) {
      mission.status = 'active'
      mission.esimStatus = 'active'
    }

    await this.repo.save(mission)
    return { valid: true, status: 'settled', txHash, balanceUsdc: mission.balanceUsdc }
  }

  async finishMission(missionId: string) {
    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (this.isLiveMode() && (!this.hasChannelReal || !this.channelPort)) {
      const err = new Error('503: Canal Soroban o credenciales de cierre no disponibles en modo live (falta CHANNEL_CONTRACT o SIGNER_SECRET)')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    let closeTxHash = `close_tx_${Date.now()}`
    if (this.channelPort?.closeStart && mission.channelId) {
      try {
        const res = await this.channelPort.closeStart({ channel: mission.channelId })
        closeTxHash = res.txHash
      } catch {
        // Fallback
      }
    }

    if (mission.iccid) {
      try {
        await this.connectivity.refundUnused(mission.iccid)
      } catch {
        // Fallback
      }
    }

    mission.status = 'completed'
    mission.esimStatus = 'disabled'
    mission.closeTxHash = closeTxHash
    await this.repo.save(mission)

    return { txHash: closeTxHash, status: 'completed' }
  }

  private getOrCreateMeterService(mission: ProductMission): IntegratedMeterService {
    let meterService = this.meters.get(mission.id)
    if (meterService) return meterService

    let session = this.sessions.get(mission.id)
    if (!session) {
      session = createConnectivitySession({
        id: `ses_${mission.id}`,
        userId: mission.userId,
        iccid: mission.iccid || `iccid_${mission.id}`,
        channelId: mission.channelId || process.env.CHANNEL_CONTRACT || `channel_${mission.id}`,
      })
      this.sessions.set(mission.id, session)
    }

    const pricePerMbRaw = BigInt(process.env.PRICE_PER_MB_RAW || process.env.TELNYX_PRICE_PER_MB_USDC || 10000000)
    const voucherPricePerMibRaw = BigInt(process.env.PRICE_PER_MIB_RAW || pricePerMibFromPerMbRaw(pricePerMbRaw).toString())

    const balancePort: ChannelBalancePort = this.balancePort || {
      async getChannelBalance() {
        return BigInt(Math.round(mission.budgetUsdc * 1e7))
      },
    }

    if (!this.voucherPort) {
      throw new Error('VoucherPort no inyectado en MissionProductService')
    }

    meterService = new IntegratedMeterService({
      session,
      provider: this.connectivity,
      balancePort,
      voucherPort: this.voucherPort,
      network: this.network,
      pricePerMbRaw,
      voucherPricePerMibRaw,
    })

    this.meters.set(mission.id, meterService)
    return meterService
  }

  async processDemoTraffic(missionId: string, bytes: number) {
    if (process.env.ENABLE_DEMO_TRAFFIC !== 'true') {
      throw new Error('La inyección de tráfico de prueba no está habilitada en el servidor')
    }

    const mission = await this.repo.findById(missionId)
    if (!mission) throw new Error(`Misión ${missionId} no encontrada`)

    if (mission.status !== 'active' || mission.esimStatus !== 'active') {
      throw new Error('No se puede inyectar tráfico a una misión inactiva o pausada')
    }

    if (this.isLiveMode() && (!this.hasVoucherAgentReal || !this.hasChannelReal || !this.hasCitrusReal)) {
      const err = new Error('503: Toda la cadena real (Voucher Agent, Soroban Channel y Citrus) debe estar disponible en modo live para procesar tráfico')
      ;(err as unknown as { statusCode: number }).statusCode = 503
      throw err
    }

    const meterService = this.getOrCreateMeterService(mission)
    const result = await meterService.processTraffic(bytes)

    const currentBytes = BigInt(mission.meteredBytes || '0') + BigInt(bytes)
    const meteredBytesStr = currentBytes.toString()
    mission.meteredBytes = meteredBytesStr

    const totalBytesNum = Number(meteredBytesStr)
    const totalMb = totalBytesNum / 1_000_000
    const costUsdc = totalMb * mission.destination.pricePerMbUsdc

    mission.consumedMb = parseFloat(totalMb.toFixed(2))
    mission.consumedUsdc = parseFloat(costUsdc.toFixed(6))
    mission.balanceUsdc = Math.max(0, parseFloat((mission.budgetUsdc - costUsdc).toFixed(6)))

    if (result.actionApplied.kind === 'suspend' || mission.balanceUsdc <= 0) {
      mission.status = 'paused'
      mission.esimStatus = 'paused'
    }

    await this.repo.save(mission)

    let cumulativeAmount: string | undefined
    let remaining: string | undefined
    let reused: boolean | undefined
    let meterReadingId: string | undefined

    if (result.voucher.kind === 'signed') {
      cumulativeAmount = result.voucher.envelope.voucher.cumulativeAmount
      remaining = result.voucher.envelope.remaining
      reused = result.voucher.envelope.reused
      meterReadingId = result.voucher.envelope.meterReadingId
    } else if (result.voucher.kind === 'unsigned') {
      remaining = result.voucher.envelope.remaining
    }

    const actionApplied = {
      ...result.actionApplied,
      remainingRaw: result.actionApplied.remainingRaw.toString(),
    }

    return {
      bytes,
      meterStatus: result.meterStatus,
      actionApplied,
      voucher: result.voucher,
      cumulativeAmount,
      remaining,
      reused,
      meterReadingId,
      meteredBytes: mission.meteredBytes,
      consumedMb: mission.consumedMb,
      consumedUsdc: mission.consumedUsdc,
      balanceUsdc: mission.balanceUsdc,
      status: mission.status,
      demoTraffic: true,
    }
  }
}
