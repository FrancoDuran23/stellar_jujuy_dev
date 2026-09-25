import { CosmoPayService } from '../../services/CosmoPayService.ts'
import { createTelnyxProvider } from '../../providers/connectivity/TelnyxProvider.ts'
import type { ConnectivityProvider, EsimRecord, SimUsage } from '../../providers/connectivity/ConnectivityProvider.ts'
import { createServerChannelStatePort } from '../../config/boot.ts'
import { createStellarChannelBalanceAdapter } from '../../meter/meter-service.ts'
import type { ChannelBalancePort } from '../../services/PolicyEnforcer.ts'
import { createHttpVoucherPort, withVoucherRetry, createInMemoryVoucherPort, type VoucherPort } from '../../meter/voucher-port.ts'
import { createRealChannelPort, type ChannelPort } from '../../agent/channel.ts'
import { FileMissionRepository } from '../persistence/MissionRepository.ts'
import { MissionProductService } from '../services/MissionProductService.ts'
import type { Network } from '../../shared/stellar/network.ts'

class MockConnectivityProvider implements ConnectivityProvider {
  async purchaseEsim(userId: string): Promise<EsimRecord> {
    const id = `sim_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const iccid = `8954000${Math.floor(Math.random() * 1e12)}`
    return {
      simCardId: id,
      iccid,
      activationCode: `LPA:1$rsp.astroam.demo$DEMO_${userId.toUpperCase()}_${Date.now()}`,
    }
  }

  async enable(_simCardId: string): Promise<void> {}
  async disable(_simCardId: string): Promise<void> {}
  async setDataLimit(_simCardId: string, _mb: number): Promise<void> {}
  async getUsage(_simCardId: string): Promise<SimUsage> {
    return { mb: 0, status: 'enabled' }
  }
}

export function bootProductService(env: Record<string, string | undefined> = process.env): MissionProductService {
  const repo = new FileMissionRepository(env.DATA_DIR)
  const cosmoPay = new CosmoPayService({
    apiKey: env.COSMOS_PAY_API_KEY,
    destination: env.COSMOS_PAY_DESTINATION,
  })

  let telnyx: ConnectivityProvider
  let hasTelnyxReal = false

  if (env.TELNYX_API_KEY && env.TELNYX_SIM_GROUP_ID) {
    try {
      telnyx = createTelnyxProvider(env as NodeJS.ProcessEnv)
      hasTelnyxReal = true
    } catch {
      telnyx = new MockConnectivityProvider()
    }
  } else {
    telnyx = new MockConnectivityProvider()
  }

  // 1. VoucherPort
  let voucherPort: VoucherPort
  let hasVoucherAgentReal = false
  const agentUrl = env.AGENT_VOUCHERS_URL

  if (agentUrl) {
    try {
      const rawPort = createHttpVoucherPort({
        url: agentUrl,
        gatewayToken: env.GATEWAY_TOKEN || '',
      })
      voucherPort = withVoucherRetry(rawPort)
      hasVoucherAgentReal = true
    } catch {
      voucherPort = createInMemoryVoucherPort({
        depositRaw: 100_000_000n,
      })
    }
  } else {
    voucherPort = createInMemoryVoucherPort({
      depositRaw: 100_000_000n,
    })
  }

  // 2. ChannelState & BalancePort
  let balancePort: ChannelBalancePort | undefined
  let hasChannelReal = false
  const networkStr = (env.STELLAR_NETWORK || env.NETWORK || 'stellar:testnet') as Network
  const rpcUrl = env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
  const dataDir = env.DATA_DIR || './data'

  if (env.CHANNEL_CONTRACT) {
    try {
      const serverStatePort = createServerChannelStatePort({
        SOROBAN_RPC_URL: rpcUrl,
        STELLAR_NETWORK: networkStr,
        DATA_DIR: dataDir,
      })
      balancePort = createStellarChannelBalanceAdapter(serverStatePort)
      hasChannelReal = true
    } catch {
      // Fallback
    }
  }

  // 3. ChannelPort
  let channelPort: ChannelPort | undefined
  const funderSecret = env.SIGNER_SECRET || env.FEE_PAYER_SECRET
  if (env.CHANNEL_CONTRACT && funderSecret) {
    try {
      channelPort = createRealChannelPort(
        {
          funderSecret,
          recipientPublicKey: env.STELLAR_RECIPIENT || '',
          usdcContract: env.USDC_SAC_CONTRACT || '',
          network: networkStr,
          channelContract: env.CHANNEL_CONTRACT,
        },
        rpcUrl,
      )
    } catch {
      // Fallback
    }
  }

  return new MissionProductService({
    repo,
    cosmoPay,
    telnyx,
    voucherPort,
    balancePort,
    channelPort,
    hasTelnyxReal,
    hasChannelReal,
    hasVoucherAgentReal,
    network: networkStr,
  })
}
