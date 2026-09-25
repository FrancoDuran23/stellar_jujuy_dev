/**
 * Frontend environment configuration & validation
 *
 * ONLY public variables prefixed with VITE_ are allowed.
 * NEVER import or expose private backend secrets here.
 */

export type AstroamMode = 'api' | 'demo'

export type FrontendConfig = {
  mode: AstroamMode
  apiBaseUrl: string
  isDemo: boolean
}

function getEnvMode(): AstroamMode {
  const raw = import.meta.env.VITE_ASTROAM_MODE
  if (raw === 'demo') return 'demo'
  return 'api' // Default mode is API
}

function getApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL
  if (raw) {
    return raw.replace(/\/+$/, '')
  }
  return '/api'
}

export const envConfig: FrontendConfig = {
  mode: getEnvMode(),
  apiBaseUrl: getApiBaseUrl(),
  isDemo: getEnvMode() === 'demo',
}

// Security audit assertion: ensure no private secrets leaked into import.meta.env
if (typeof window !== 'undefined') {
  const forbiddenKeys = [
    'CITRUS_API_KEY',
    'CITRUS_WEBHOOK_SECRET',
    'COMMITMENT_SECRET',
    'SIGNER_SECRET',
    'FEE_PAYER_SECRET',
    'GATEWAY_TOKEN',
    'MPP_SECRET_KEY',
    'COSMOS_PAY_API_KEY',
  ]

  for (const key of forbiddenKeys) {
    if (key in import.meta.env) {
      console.error(`[SECURITY ALERT] Private key '${key}' detected in client bundle!`)
    }
  }
}
