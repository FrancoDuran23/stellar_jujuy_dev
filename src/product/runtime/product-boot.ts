import { CosmoPayService } from '../../services/CosmoPayService.ts'
import { createConnectivityProvider } from '../../providers/connectivity/createConnectivityProvider.ts'
import { FakeProvider } from '../../providers/connectivity/FakeProvider.ts'
import type { ConnectivityProvider } from '../../providers/connectivity/ConnectivityProvider.ts'
import { createServerChannelStatePort } from '../../config/boot.ts'
import { createStellarChannelBalanceAdapter } from '../../meter/meter-service.ts'
import type { ChannelBalancePort } from '../../services/PolicyEnforcer.ts'
import { createHttpVoucherPort, withVoucherRetry, createInMemoryVoucherPort, type VoucherPort } from '../../meter/voucher-port.ts'
import { createRealChannelPort, type ChannelPort } from '../../agent/channel.ts'
import { FileMissionRepository } from '../persistence/MissionRepository.ts'
import { MissionProductService } from '../services/MissionProductService.ts'
import type { Network } from '../../shared/stellar/network.ts'

export function bootProductService(env: Record<string, string | undefined> = process.env): MissionProductService {
  const repo = new FileMissionRepository(env.DATA_DIR)
  const cosmoPay = new CosmoPayService({
    apiKey: env.COSMOS_PAY_API_KEY,
    destination: env.COSMOS_PAY_DESTINATION,
  })

  let connectivity: ConnectivityProvider
  let hasCitrusReal = false
  const providerKind = (env.CONNECTIVITY_PROVIDER === 'citrus' ? 'citrus' : 'fake')

  if (providerKind === 'citrus' && env.CITRUS_API_KEY) {
    try {
      const bundle = createConnectivityProvider({
        CONNECTIVITY_PROVIDER: 'citrus',
        CITRUS_API_KEY: env.CITRUS_API_KEY,
        CITRUS_BASE_URL: env.CITRUS_BASE_URL,
        PRICE_PER_MB_RAW: BigInt(env.PRICE_PER_MB_RAW || env.TELNYX_PRICE_PER_MB_USDC || 10000000),
        STELLAR_NETWORK: env.STELLAR_NETWORK || env.NETWORK || 'stellar:testnet',
        DATA_DIR: env.DATA_DIR || './data',
      })
      connectivity = bundle.provider
      hasCitrusReal = true
    } catch {
      connectivity = new FakeProvider()
    }
  } else {
    connectivity = new FakeProvider()
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
    connectivity,
    voucherPort,
    balancePort,
    channelPort,
    hasCitrusReal,
    hasChannelReal,
    hasVoucherAgentReal,
    network: networkStr,
  })
}
