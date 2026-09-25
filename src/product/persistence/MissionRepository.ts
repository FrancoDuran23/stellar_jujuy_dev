import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProductMission } from '../types/mission.ts'

export interface MissionRepository {
  save(mission: ProductMission): Promise<void>
  findById(id: string): Promise<ProductMission | null>
  findByPaymentIntentId(intentId: string): Promise<ProductMission | null>
  findAll(): Promise<ProductMission[]>
}

export class FileMissionRepository implements MissionRepository {
  private filePath: string

  constructor(dataDir?: string) {
    const dir = dataDir || process.env.DATA_DIR || './data'
    this.filePath = path.resolve(dir, 'missions.json')
  }

  private async ensureFile(): Promise<Record<string, ProductMission>> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const raw = await fs.readFile(this.filePath, 'utf-8')
      return JSON.parse(raw) as Record<string, ProductMission>
    } catch {
      return {}
    }
  }

  private async writeAtomic(data: Record<string, ProductMission>): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    const tempFile = path.join(dir, `missions.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tempFile, this.filePath)
  }

  async save(mission: ProductMission): Promise<void> {
    const store = await this.ensureFile()
    mission.updatedAt = new Date().toISOString()
    store[mission.id] = mission
    await this.writeAtomic(store)
  }

  async findById(id: string): Promise<ProductMission | null> {
    const store = await this.ensureFile()
    return store[id] || null
  }

  async findByPaymentIntentId(intentId: string): Promise<ProductMission | null> {
    const store = await this.ensureFile()
    for (const m of Object.values(store)) {
      if (m.paymentIntentId === intentId) return m
      for (const t of m.topups || []) {
        if (t.intentId === intentId) return m
      }
    }
    return null
  }

  async findAll(): Promise<ProductMission[]> {
    const store = await this.ensureFile()
    return Object.values(store)
  }
}
