import express from 'express'
import http from 'node:http'
import { createServerApp } from '../src/server/app.ts'
import type { FailClosedBoot, ServerChannelInstance } from '../src/config/boot.ts'
import type { ChargePort } from '../src/server/charge-service.ts'

const mockChargePort: ChargePort = {
  async handle() {
    return { kind: 'failed', reason: 'internal_error', detail: 'stub' }
  },
}

const mockBoot: FailClosedBoot<ChargePort> = {
  getState() {
    return { status: 'ready', instance: mockChargePort }
  },
  async ensureReady() {
    return { status: 'ready', instance: mockChargePort }
  },
}

const app = createServerApp({
  boot: mockBoot,
  network: 'stellar:testnet',
  explorerBaseUrl: 'https://stellar.expert/explorer/testnet',
  pricePerMibRaw: 10485760n,
})

const server = http.createServer(app)

server.listen(0, '127.0.0.1', async () => {
  const addr = server.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`
  console.log(`Smoke test server listening on ${base}`)

  try {
    // 1. GET /health
    const hRes = await fetch(`${base}/health`)
    console.log(`GET /health -> HTTP ${hRes.status}:`, await hRes.json())

    // 2. GET /ready
    const rRes = await fetch(`${base}/ready`)
    console.log(`GET /ready -> HTTP ${rRes.status}:`, await rRes.json())

    // 3. GET /api/capabilities
    const cRes = await fetch(`${base}/api/capabilities`)
    console.log(`GET /api/capabilities -> HTTP ${cRes.status}:`, await cRes.json())

    // 4. POST /api/missions (Create Mission)
    const mRes = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'smoke_user',
        destination: { id: 'bol', name: 'Bolivia', flag: '🇧🇴', network: 'ENTEL', coverage: '4G', pricePerMbUsdc: 0.007 },
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        budgetUsdc: 10,
        dailyLimitUsdc: 3,
      }),
    })
    const mData = (await mRes.json()) as { id: string }
    console.log(`POST /api/missions -> HTTP ${mRes.status}:`, mData)

    // 5. POST /api/missions/:id/payment-intent
    const piRes = await fetch(`${base}/api/missions/${mData.id}/payment-intent`, { method: 'POST' })
    const piData = (await piRes.json()) as { intentId: string; uri: string; isMock: boolean }
    console.log(`POST /api/missions/:id/payment-intent -> HTTP ${piRes.status}:`, { intentId: piData.intentId, isMock: piData.isMock })

    // 6. POST /api/missions/:id/payment-confirmation
    const pcRes = await fetch(`${base}/api/missions/${mData.id}/payment-confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId: piData.intentId, txHash: '0xsmoke_tx_123' }),
    })
    console.log(`POST /api/missions/:id/payment-confirmation -> HTTP ${pcRes.status}:`, await pcRes.json())

    // 7. POST /api/missions/:id/activate
    const actRes = await fetch(`${base}/api/missions/${mData.id}/activate`, { method: 'POST' })
    const actData = (await actRes.json()) as { status: string; esim?: { iccid: string; lpaString: string } }
    console.log(`POST /api/missions/:id/activate -> HTTP ${actRes.status}:`, { status: actData.status, esim: actData.esim })

    // 8. GET /api/missions/:id
    const gRes = await fetch(`${base}/api/missions/${mData.id}`)
    console.log(`GET /api/missions/:id -> HTTP ${gRes.status}:`, { status: (await gRes.json() as { status: string }).status })

    // 9. POST /api/missions/:id/pause & resume
    const pRes = await fetch(`${base}/api/missions/${mData.id}/pause`, { method: 'POST' })
    console.log(`POST /api/missions/:id/pause -> HTTP ${pRes.status}:`, await pRes.json())

    const resRes = await fetch(`${base}/api/missions/${mData.id}/resume`, { method: 'POST' })
    console.log(`POST /api/missions/:id/resume -> HTTP ${resRes.status}:`, await resRes.json())

    // 10. POST /api/missions/:id/demo-traffic
    process.env.ENABLE_DEMO_TRAFFIC = 'true'
    const dtRes = await fetch(`${base}/api/missions/${mData.id}/demo-traffic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: 500000 }),
    })
    console.log(`POST /api/missions/:id/demo-traffic -> HTTP ${dtRes.status}:`, await dtRes.json())

    // 11. POST /api/missions/:id/finish
    const fRes = await fetch(`${base}/api/missions/${mData.id}/finish`, { method: 'POST' })
    console.log(`POST /api/missions/:id/finish -> HTTP ${fRes.status}:`, await fRes.json())

    console.log('--- SMOKE TEST COMPLETED SUCCESSFULLY ---')
  } catch (err) {
    console.error('Smoke test failed:', err)
  } finally {
    server.close()
  }
})
