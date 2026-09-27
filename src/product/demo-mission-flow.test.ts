// Flujo de demo sin servicios reales (FakeProvider + agente de pagos simulado
// por misión), como lo levanta `npm run server` con el .env.example.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { MissionProductService } from './services/MissionProductService.ts'
import type { MissionRepository } from './persistence/MissionRepository.ts'
import type { ProductMission } from './types/mission.ts'
import { CosmoPayService } from '../services/CosmoPayService.ts'
import { FakeProvider } from '../providers/connectivity/FakeProvider.ts'
import { createInMemoryVoucherPort } from '../meter/voucher-port.ts'
import { isStellarContractId } from '../shared/stellar/keys.ts'

class MemoryRepo implements MissionRepository {
  private store = new Map<string, ProductMission>()

  async save(mission: ProductMission): Promise<void> {
    this.store.set(mission.id, structuredClone(mission))
  }

  async findById(id: string): Promise<ProductMission | null> {
    const mission = this.store.get(id)
    return mission ? structuredClone(mission) : null
  }

  async findByPaymentIntentId(intentId: string): Promise<ProductMission | null> {
    for (const m of this.store.values()) {
      if (m.paymentIntentId === intentId) return structuredClone(m)
    }
    return null
  }

  async findAll(): Promise<ProductMission[]> {
    return Array.from(this.store.values(), (m) => structuredClone(m))
  }
}

const BRASIL = {
  id: 'br',
  name: 'Brasil',
  flag: 'BR',
  network: 'Vivo',
  coverage: '4G/5G',
  pricePerMbUsdc: 0.0025,
}

let service: MissionProductService

before(() => {
  process.env.ENABLE_DEMO_TRAFFIC = 'true'
  delete process.env.ASTROAM_LIVE_ENABLED
  delete process.env.PRICE_PER_MB_RAW
  delete process.env.PRICE_PER_MIB_RAW
  delete process.env.CHANNEL_CONTRACT

  service = new MissionProductService({
    repo: new MemoryRepo(),
    cosmoPay: new CosmoPayService(),
    connectivity: new FakeProvider(),
    createOfflineVoucherPort: (depositRaw) => createInMemoryVoucherPort({ depositRaw }),
  })
})

async function activeMission(budgetUsdc: number): Promise<string> {
  const { id } = await service.createMission({
    destination: BRASIL,
    startDate: '2026-10-01',
    endDate: '2026-10-04',
    budgetUsdc,
    dailyLimitUsdc: budgetUsdc,
  })
  const intent = await service.createPaymentIntent(id)
  await service.confirmPayment(id, intent.intentId, 'demo_tx_hash')
  await service.activateMission(id)
  return id
}

test('una misión de demo recibe un canal con formato Soroban válido', async () => {
  const id = await activeMission(5)
  const mission = await service.getMission(id)
  assert.ok(isStellarContractId(mission.channelId), `channelId inválido: ${mission.channelId}`)
})

test('el tráfico de demo firma vales y cobra la tarifa del destino, sin pausar antes de tiempo', async () => {
  const id = await activeMission(5) // 5 USDC a 0,0025 USDC/MB = 2.000 MB

  const legs = [300, 700, 800]
  for (const mb of legs) {
    const res = await service.processDemoTraffic(id, mb * 1_000_000)
    assert.equal(res.voucher.kind, 'signed', `tramo de ${mb} MB sin vale firmado`)
    assert.equal(res.status, 'active', `la misión se pausó en el tramo de ${mb} MB`)
  }

  const last = await service.processDemoTraffic(id, 600 * 1_000_000) // 2.400 MB > 2.000
  assert.equal(last.voucher.kind, 'unsigned')
  assert.equal(last.status, 'paused')
})

test('dos misiones no se pisan los vales entre sí', async () => {
  const a = await activeMission(5)
  const b = await activeMission(5)

  await service.processDemoTraffic(a, 1_000 * 1_000_000)
  const res = await service.processDemoTraffic(b, 300 * 1_000_000)
  assert.equal(res.voucher.kind, 'signed', 'la segunda misión no debería ver el vale de la primera')
})

test('la eSIM de demo trae una imagen de QR válida', async () => {
  const id = await activeMission(5)
  const mission = await service.getMission(id)
  const qr = mission.esim?.qrCode ?? ''
  assert.match(qr, /^data:image\/svg\+xml;base64,/)
  assert.match(Buffer.from(qr.split(',')[1]!, 'base64').toString('utf8'), /^<svg /)
})
