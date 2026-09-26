import { Router, type Request, type Response, type NextFunction } from 'express'
import type { MissionProductService } from '../services/MissionProductService.ts'
import {
  createMissionSchema,
  paymentConfirmationSchema,
  topupIntentSchema,
  topupConfirmationSchema,
  demoTrafficSchema,
} from '../schemas/mission.ts'

function getId(req: Request): string {
  const raw = req.params.id
  return Array.isArray(raw) ? raw[0] : raw
}

export function createProductRouter(service: MissionProductService): Router {
  const router = Router()

  // CORS Middleware
  router.use((_req: Request, res: Response, next: NextFunction) => {
    const origin = process.env.FRONTEND_ORIGIN || '*'
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // Auth & Live Guard Middleware for mutable endpoints when live mode is active
  const requireAuthIfNeeded = (req: Request, res: Response, next: NextFunction) => {
    if (process.env.ASTROAM_LIVE_ENABLED === 'true') {
      const origin = process.env.FRONTEND_ORIGIN
      if (!origin || origin === '*') {
        res.status(503).json({
          error: 'service_unavailable',
          message: "FRONTEND_ORIGIN con '*' no está permitido en modo live",
        })
        return
      }

      if (!process.env.ASTROAM_DEMO_ACCESS_TOKEN) {
        res.status(503).json({
          error: 'service_unavailable',
          message: 'ASTROAM_DEMO_ACCESS_TOKEN debe configurarse en el servidor para operaciones mutables en modo live',
        })
        return
      }

      const auth = req.headers.authorization
      const expected = `Bearer ${process.env.ASTROAM_DEMO_ACCESS_TOKEN}`
      if (auth !== expected) {
        res.status(401).json({
          error: 'unauthorized',
          message: 'Se requiere token de acceso válido para operaciones mutables en modo live',
        })
        return
      }
    }
    next()
  }

  // 1. Capabilities
  router.get('/capabilities', async (_req: Request, res: Response) => {
    try {
      const caps = await service.getCapabilities()
      res.json(caps)
    } catch (err) {
      res.status(500).json({ error: 'capabilities_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 2. Create Mission
  router.post('/missions', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const parsed = createMissionSchema.parse(req.body)
      const result = await service.createMission(parsed)
      res.status(201).json(result)
    } catch (err) {
      res.status(400).json({ error: 'invalid_request', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 3. Payment Intent
  router.post('/missions/:id/payment-intent', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const result = await service.createPaymentIntent(getId(req))
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'payment_intent_error', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 4. Payment Confirmation
  router.post('/missions/:id/payment-confirmation', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const parsed = paymentConfirmationSchema.parse(req.body)
      const result = await service.confirmPayment(getId(req), parsed.intentId, parsed.txHash)
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'payment_confirmation_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 5. Activate Mission
  router.post('/missions/:id/activate', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const result = await service.activateMission(getId(req))
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'activation_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 6. Get Mission Status
  router.get('/missions/:id', async (req: Request, res: Response) => {
    try {
      const result = await service.getMission(getId(req))
      res.json(result)
    } catch (err) {
      res.status(404).json({ error: 'not_found', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 7. Get Mission Usage
  router.get('/missions/:id/usage', async (req: Request, res: Response) => {
    try {
      const result = await service.getUsage(getId(req))
      res.json(result)
    } catch (err) {
      res.status(404).json({ error: 'not_found', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 8. Pause Mission
  router.post('/missions/:id/pause', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const result = await service.pauseMission(getId(req))
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'pause_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 9. Resume Mission
  router.post('/missions/:id/resume', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const result = await service.resumeMission(getId(req))
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'resume_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 10. TopUp Payment Intent & Confirmation
  router.post('/missions/:id/topups/payment-intent', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const parsed = topupIntentSchema.parse(req.body)
      const result = await service.createTopUpIntent(getId(req), parsed.amountUsdc)
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'topup_intent_error', message: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/missions/:id/topups/payment-confirmation', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const parsed = topupConfirmationSchema.parse(req.body)
      const result = await service.confirmTopUpPayment(getId(req), parsed.intentId, parsed.txHash)
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'topup_confirmation_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 11. Finish Mission
  router.post('/missions/:id/finish', requireAuthIfNeeded, async (req: Request, res: Response) => {
    try {
      const result = await service.finishMission(getId(req))
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'finish_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  // 12. Demo Traffic Injection (only if ENABLE_DEMO_TRAFFIC=true)
  router.post('/missions/:id/demo-traffic', requireAuthIfNeeded, async (req: Request, res: Response) => {
    if (process.env.ENABLE_DEMO_TRAFFIC !== 'true') {
      res.status(403).json({ error: 'forbidden', message: 'Demo traffic injection is not enabled' })
      return
    }
    try {
      const parsed = demoTrafficSchema.parse(req.body)
      const result = await service.processDemoTraffic(getId(req), parsed.bytes)
      res.json(result)
    } catch (err) {
      const is503 = err instanceof Error && err.message.includes('503:')
      res.status(is503 ? 503 : 400).json({ error: 'demo_traffic_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  return router
}
