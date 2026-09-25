import { useMission } from '../hooks/useMission'

export default function SystemBadge() {
  const { caps, backendError, isDemoMode } = useMission()

  if (isDemoMode) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] font-mono font-bold text-amber-600 tracking-wider uppercase">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        MODO DEMO · SIN OPERACIONES REALES
      </span>
    )
  }

  if (backendError || !caps || !caps.backendAvailable) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-alerta/10 border border-alerta/30 text-[10px] font-mono font-bold text-alerta tracking-wider uppercase">
        <span className="w-1.5 h-1.5 rounded-full bg-alerta" />
        BACKEND NO DISPONIBLE
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-online/10 border border-online/30 text-[10px] font-mono font-bold text-online tracking-wider uppercase">
      <span className="w-1.5 h-1.5 rounded-full bg-online animate-pulse" />
      API {caps.citrusReady ? 'LIVE' : 'CONECTADA'}
    </span>
  )
}
