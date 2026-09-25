import { useMission } from '../hooks/useMission'

export default function SystemBadge() {
  const { caps, backendError, isDemoMode } = useMission()

  if (isDemoMode) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] font-mono font-bold text-amber-600 tracking-wider uppercase">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        MODO DEMO
      </span>
    )
  }

  if (backendError || !caps || !caps.backendAvailable) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-alerta/10 border border-alerta/30 text-[10px] font-mono font-bold text-alerta tracking-wider uppercase">
        <span className="w-1.5 h-1.5 rounded-full bg-alerta" />
        BACKEND OFFLINE
      </span>
    )
  }

  const isFullyConnected = caps.backendAvailable && caps.citrusReady && caps.channelReady

  if (isFullyConnected) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-online/10 border border-online/30 text-[10px] font-mono font-bold text-online tracking-wider uppercase">
        <span className="w-1.5 h-1.5 rounded-full bg-online animate-pulse" />
        TESTNET CONECTADA
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-stellar/10 border border-stellar/30 text-[10px] font-mono font-bold text-stellar tracking-wider uppercase">
      <span className="w-1.5 h-1.5 rounded-full bg-stellar animate-pulse" />
      CONFIGURANDO RED
    </span>
  )
}
