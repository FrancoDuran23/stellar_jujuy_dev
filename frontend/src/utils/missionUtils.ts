import type { Destination } from '../types/mission'

export const DESTINATIONS: Destination[] = [
  {
    id: 'brasil',
    name: 'Brasil',
    flag: '🇧🇷',
    network: 'Claro / TIM 5G',
    coverage: '5G / 4G LTE',
    pricePerMbUsdc: 0.001,
  },
  {
    id: 'chile',
    name: 'Chile',
    flag: '🇨🇱',
    network: 'Entel / Movistar 4G',
    coverage: '4G LTE',
    pricePerMbUsdc: 0.0008,
  },
  {
    id: 'bolivia',
    name: 'Bolivia',
    flag: '🇧🇴',
    network: 'Tigo / Entel 4G',
    coverage: '4G / 3G',
    pricePerMbUsdc: 0.0006,
  },
]

export const ORIGIN = { id: 'argentina', name: 'Argentina', flag: '🇦🇷' }

export const PRICE_PER_MIB_RAW = 10_000_000n   // 1 USDC/MiB in raw units (demo)
export const STELLAR_NETWORK = 'stellar:testnet'

/** How many MB a given USDC budget buys at the destination's price */
export function estimateMb(budgetUsdc: number, pricePerMbUsdc: number): number {
  if (pricePerMbUsdc <= 0) return 0
  return Math.floor(budgetUsdc / pricePerMbUsdc)
}

/** Format a USDC amount for display */
export function fmtUsdc(amount: number, decimals = 4): string {
  return amount.toLocaleString('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** Format MB for display */
export function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

/** Short tx hash for display */
export function shortTx(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`
}

/** Random hex string */
export function randomHex(len = 64): string {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('')
}

/** ISO date string (YYYY-MM-DD) for today */
export function today(): string {
  return new Date().toISOString().split('T')[0]
}

/** Add N days to an ISO date string */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

/** Count days between two ISO date strings (inclusive) */
export function daysBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return Math.max(1, Math.round(ms / 86_400_000) + 1)
}

/** Format date for display */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/** Format timestamp HH:MM */
export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}
