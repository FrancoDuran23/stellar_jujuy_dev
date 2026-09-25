import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { estimateMb, fmtMb, DESTINATIONS } from './missionUtils.js'

describe('missionUtils tariff & estimation', () => {
  it('estimates Brasil 10 USDC as exactly 4000 MB = 4.0 GB', () => {
    const brasil = DESTINATIONS.find((d) => d.id === 'brasil')
    assert.ok(brasil)
    assert.equal(brasil.pricePerMbUsdc, 0.0025)

    const mb = estimateMb(10, brasil.pricePerMbUsdc)
    assert.equal(mb, 4000)

    const formatted = fmtMb(mb)
    assert.equal(formatted, '4.0 GB')
  })

  it('returns 0 and handles missing tariff gracefully', () => {
    assert.equal(estimateMb(10, undefined), 0)
    assert.equal(estimateMb(10, 0), 0)
    assert.equal(fmtMb(0), '0 MB')
  })
})
