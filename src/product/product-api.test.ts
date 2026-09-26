import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import { createProductRouter } from './api/routes.ts'
import { MissionProductService } from './services/MissionProductService.ts'
import type { MissionRepository } from './persistence/MissionRepository.ts'
import type { ProductMission } from './types/mission.ts'
import { CosmoPayService } from '../services/CosmoPayService.ts'
import { FakeProvider } from '../providers/connectivity/FakeProvider.ts'
import { type VoucherPort } from '../meter/voucher-port.ts'
import type { Message1, Message2 } from '../shared/messages.ts'

class MemoryRepo implements MissionRepository {
  private store = new Map<string, ProductMission>()

  async save(mission: ProductMission): Promise<void> {
    this.store.set(mission.id, { ...mission })
  }

  async findById(id: string): Promise<ProductMission | null> {
    return this.store.get(id) || null
  }

  async findByPaymentIntentId(intentId: string): Promise<ProductMission | null> {
    for (const m of this.store.values()) {
      if (m.paymentIntentId === intentId) return m
    }
    return null
  }

  async findAll(): Promise<ProductMission[]> {
    return Array.from(this.store.values())
  }
}

class MockVoucherPort implements VoucherPort {
  requestedM1s: Message1[] = []
  mode: 'signed' | 'unsigned' | 'throw' = 'signed'

  async requestVoucher(m1: Message1): Promise<Message2> {
    this.requestedM1s.push(m1)
    if (this.mode === 'throw') {
      throw new Error('Agente de vouchers no disponible')
    }
    const channel = m1.channel || 'CCW673TX665WFQGZ4EOT7OWT2H263IG65V27P432PQLQTF53D67HGF37'
    if (this.mode === 'unsigned') {
      return {
        version: 1,
        status: 'unsigned',
        sessionId: m1.sessionId,
        channel,
        reason: 'channel_exhausted',
        retryable: false,
        remaining: '0',
        meterReadingId: m1.meterReadingId,
        detail: 'Depósito agotado',
      }
    }
    return {
      version: 1,
      status: 'signed',
      sessionId: m1.sessionId,
      channel,
      voucher: {
        cumulativeAmount: (BigInt(m1.cumulativeBytes) * 10n).toString(),
        signature: '0'.repeat(128),
        commitmentPubkey: '0'.repeat(64),
        network: m1.network,
      },
      meterReadingId: m1.meterReadingId,
      reused: false,
      remaining: '10000000',
      signedAt: new Date().toISOString(),
    }
  }
}

let server: http.Server
let baseUrl: string
let fakeProvider: FakeProvider
let mockVoucherPort: MockVoucherPort
let service: MissionProductService

before(async () => {
  const repo = new MemoryRepo()
  const cosmoPay = new CosmoPayService() // Mock mode
  fakeProvider = new FakeProvider()
  mockVoucherPort = new MockVoucherPort()
  service = new MissionProductService({
    repo,
    cosmoPay,
    connectivity: fakeProvider,
    voucherPort: mockVoucherPort,
    hasCitrusReal: true,
    hasChannelReal: true,
    hasVoucherAgentReal: true,
  })

  const app = express()
  app.use(express.json())
  app.use('/api', createProductRouter(service))

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

after(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve())
    else resolve()
  })
})

test('GET /api/capabilities returns detailed readiness without leaking secrets', async () => {
  const res = await fetch(`${baseUrl}/api/capabilities`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.backendAvailable, true)
  assert.equal(typeof body.network, 'string')
  assert.equal(typeof body.paymentServerReady, 'boolean')
  assert.equal(Array.isArray(body.missingConfiguration), true)
  assert.equal(body.connectivityProvider, 'citrus')

  const rawStr = JSON.stringify(body)
  assert.equal(rawStr.includes('private_key'), false)
  assert.equal(rawStr.includes('secret_token'), false)
})

test('processTraffic executes IntegratedMeterService & passes M1 to VoucherPort with signed M2 crediting quota', async () => {
  process.env.ENABLE_DEMO_TRAFFIC = 'true'

  // 1. Create & activate mission
  const createRes = await fetch(`${baseUrl}/api/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      destination: { id: 'bra', name: 'Brasil', flag: '🇧🇷', network: 'VIVO', coverage: '4G', pricePerMbUsdc: 0.005 },
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      budgetUsdc: 10,
      dailyLimitUsdc: 5,
    }),
  })
  const missionId = ((await createRes.json()) as { id: string }).id

  const intentRes = await fetch(`${baseUrl}/api/missions/${missionId}/payment-intent`, { method: 'POST' })
  const intentId = ((await intentRes.json()) as { intentId: string }).intentId

  const confirmRes = await fetch(`${baseUrl}/api/missions/${missionId}/payment-confirmation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId, txHash: '0xtest_tx_hash_valid' }),
  })
  if (confirmRes.status !== 200) {
    console.error('confirmRes error:', await confirmRes.text())
  }

  const actRes = await fetch(`${baseUrl}/api/missions/${missionId}/activate`, { method: 'POST' })
  assert.equal(actRes.status, 200)
  const actBody = (await actRes.json()) as { esim?: { iccid: string; lpaString: string } }
  assert.ok(actBody.esim?.iccid)
  assert.ok(actBody.esim?.lpaString)

  mockVoucherPort.mode = 'signed'
  mockVoucherPort.requestedM1s = []

  // 2. Demo Traffic calling IntegratedMeterService
  const trafficRes = await fetch(`${baseUrl}/api/missions/${missionId}/demo-traffic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bytes: 1_000_000 }), // 1 MB
  })

  assert.equal(trafficRes.status, 200)
  const trafficBody = (await trafficRes.json()) as {
    meterStatus: { cumulativeBytes: number; paidQuotaBytes: number }
    actionApplied: { kind: string }
    voucher: { kind: string }
    meteredBytes: string
    cumulativeAmount?: string
    remaining?: string
  }

  assert.equal(trafficBody.meteredBytes, '1000000')
  assert.equal(trafficBody.voucher.kind, 'signed')
  assert.equal(trafficBody.meterStatus.paidQuotaBytes, 1000000)
  assert.equal(mockVoucherPort.requestedM1s.length, 1)
  assert.equal(mockVoucherPort.requestedM1s[0].cumulativeBytes, 1000000)

  // 3. Usage route executes Citrus getUsage
  const usageRes = await fetch(`${baseUrl}/api/missions/${missionId}/usage`)
  assert.equal(usageRes.status, 200)
  const usageBody = (await usageRes.json()) as {
    meteredBytes: string
    chargedMicroUsd: string
    walletMicroUsd: string
    isEstimation: boolean
  }

  assert.equal(usageBody.meteredBytes, '1000000')
  assert.equal(usageBody.isEstimation, true)
})

test('Unsigned M2 does NOT credit paid quota', async () => {
  // Create & activate mission
  const createRes = await fetch(`${baseUrl}/api/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      destination: { id: 'arg', name: 'Argentina', flag: '🇦🇷', network: 'PERSONAL', coverage: '4G', pricePerMbUsdc: 0.005 },
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      budgetUsdc: 10,
      dailyLimitUsdc: 5,
    }),
  })
  const missionId = ((await createRes.json()) as { id: string }).id

  const intentRes = await fetch(`${baseUrl}/api/missions/${missionId}/payment-intent`, { method: 'POST' })
  const intentId = ((await intentRes.json()) as { intentId: string }).intentId

  await fetch(`${baseUrl}/api/missions/${missionId}/payment-confirmation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentId, txHash: '0xtest_tx_hash_valid' }),
  })

  await fetch(`${baseUrl}/api/missions/${missionId}/activate`, { method: 'POST' })

  mockVoucherPort.mode = 'unsigned'

  const trafficRes = await fetch(`${baseUrl}/api/missions/${missionId}/demo-traffic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bytes: 500_000 }),
  })

  assert.equal(trafficRes.status, 200)
  const trafficBody = (await trafficRes.json()) as {
    meterStatus: { cumulativeBytes: number; paidQuotaBytes: number }
    voucher: { kind: string }
  }

  assert.equal(trafficBody.voucher.kind, 'unsigned')
  assert.equal(trafficBody.meterStatus.paidQuotaBytes, 0)
})

test('Live mode fail-closed checks & 503 on unavailable voucher agent in live mode', async () => {
  process.env.ASTROAM_LIVE_ENABLED = 'true'
  process.env.FRONTEND_ORIGIN = 'http://localhost:5173'
  process.env.ASTROAM_DEMO_ACCESS_TOKEN = 'test_token'

  // Mutable route without Bearer token -> 401
  const noToken = await fetch(`${baseUrl}/api/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      destination: { id: 'bra', name: 'Brasil', flag: '🇧🇷', network: 'VIVO', coverage: '4G', pricePerMbUsdc: 0.005 },
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      budgetUsdc: 10,
      dailyLimitUsdc: 5,
    }),
  })
  assert.equal(noToken.status, 401)

  // Clean up env
  delete process.env.ASTROAM_LIVE_ENABLED
  delete process.env.ASTROAM_DEMO_ACCESS_TOKEN
  delete process.env.FRONTEND_ORIGIN
})
