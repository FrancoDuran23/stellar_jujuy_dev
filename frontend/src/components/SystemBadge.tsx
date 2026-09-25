import { useSystemStatus } from '../hooks/useSystemStatus'

export default function SystemBadge() {
  const { backend, isDemo } = useSystemStatus()

  if (backend === 'checking') return null

  if (backend === 'offline' || isDemo) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-stellar/20 border border-stellar/40 text-[10px] font-mono font-bold text-textprimary tracking-wider uppercase">
        <span className="w-1.5 h-1.5 rounded-full bg-stellar animate-pulse" />
        MODO DEMO
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-online/10 border border-online/30 text-[10px] font-mono font-bold text-online tracking-wider uppercase">
      <span className="w-1.5 h-1.5 rounded-full bg-online animate-pulse" />
      BACKEND ACTIVO
    </span>
  )
}
