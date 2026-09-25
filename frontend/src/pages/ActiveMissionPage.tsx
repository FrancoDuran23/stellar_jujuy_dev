import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import logoSrc from '../assets/logo.png'
import shipSrc from '../assets/ship.png'
import SystemBadge from '../components/SystemBadge'
import ConsumptionGauge from '../components/dashboard/ConsumptionGauge'
import ActivityFeed from '../components/dashboard/ActivityFeed'
import TopUpModal from '../components/dashboard/TopUpModal'
import { useMission } from '../hooks/useMission'
import { fmtDate, fmtUsdc, fmtMb } from '../utils/missionUtils'

export default function ActiveMissionPage() {
  const navigate = useNavigate()
  const { mission, events, simulate, topUp, togglePause, complete, reset } = useMission()
  const [showTopUp, setShowTopUp] = useState(false)
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false)
  const [flash, setFlash] = useState(false)

  // Redirect if no mission
  useEffect(() => {
    if (!mission) {
      navigate('/mission/new', { replace: true })
    }
  }, [mission, navigate])

  if (!mission) return null

  const isPaused = mission.esimStatus === 'paused'
  const isCompleted = mission.status === 'completed'
  const pctRemaining = mission.budgetUsdc > 0
    ? (mission.balanceUsdc / mission.budgetUsdc) * 100
    : 0

  function handleSimulate() {
    setFlash(true)
    simulate()
    setTimeout(() => setFlash(false), 400)
  }

  function handleComplete() {
    complete()
    setShowCompleteConfirm(false)
  }

  function handleReset() {
    reset()
    navigate('/', { replace: true })
  }

  const statusColor = isCompleted
    ? 'text-textsecondary'
    : isPaused
      ? 'text-stellar'
      : 'text-online'

  const statusLabel = isCompleted ? 'MISIÓN FINALIZADA' : isPaused ? 'DATOS PAUSADOS' : 'CONEXIÓN ACTIVA'

  return (
    <div className="min-h-screen bg-bglight relative overflow-x-hidden">
      {/* Background grid */}
      <div className="fixed inset-0 fintech-grid opacity-50 pointer-events-none" />

      {/* Glows */}
      <div className="fixed top-0 -left-32 w-72 h-72 bg-primaryviolet/8 rounded-full blur-[100px] pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-64 h-64 bg-tealbrand/8 rounded-full blur-[80px] pointer-events-none" />

      {/* Top-up modal */}
      {showTopUp && (
        <TopUpModal
          onTopUp={topUp}
          onClose={() => setShowTopUp(false)}
        />
      )}

      {/* Complete confirmation */}
      {showCompleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-textprimary/20 backdrop-blur-sm"
            onClick={() => setShowCompleteConfirm(false)}
          />
          <div className="relative z-10 w-full max-w-sm max-h-[90vh] overflow-y-auto bg-white rounded-3xl border border-cardborder shadow-[0_20px_60px_rgba(25,24,29,0.12)] p-6 sm:p-7 flex flex-col gap-5">
            <h3 className="font-display text-xl font-bold text-textprimary">¿Finalizar misión?</h3>
            <p className="text-sm text-textsecondary leading-relaxed">
              Tu eSIM se desactivará y se ejecutará el cierre del canal Soroban <strong>(Simulado)</strong>. El saldo no consumido quedará liberado.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowCompleteConfirm(false)}
                className="flex-1 py-3 rounded-full border border-cardborder bg-white text-textsecondary font-sans font-semibold text-xs uppercase tracking-wider hover:bg-bglight transition-all"
              >
                CANCELAR
              </button>
              <button
                type="button"
                onClick={handleComplete}
                className="flex-1 py-3 rounded-full bg-alerta text-white font-sans font-bold text-xs uppercase tracking-wider hover:opacity-90 transition-all"
              >
                FINALIZAR (SIMULADO)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="relative z-10 w-full bg-white/90 backdrop-blur-md border-b border-cardborder">
        <div className="max-w-7xl mx-auto h-16 px-6 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3 group">
            <img src={logoSrc} alt="ASTROAM" className="h-7 object-contain group-hover:scale-105 transition-transform" />
          </a>
          <div className="flex items-center gap-3">
            <SystemBadge />
            <button
              type="button"
              onClick={handleReset}
              className="font-mono text-[10px] font-bold text-textsecondary/50 hover:text-alerta transition-colors uppercase tracking-wider"
            >
              REINICIAR DEMO
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-8">

        {/* Status bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-8 p-4 sm:p-5 rounded-2xl bg-white border border-cardborder shadow-sm">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full ${isCompleted ? 'bg-textsecondary/40' : isPaused ? 'bg-stellar animate-pulse' : 'bg-online animate-pulse'}`} />
            <div>
              <span className={`font-mono text-xs font-bold tracking-wider uppercase ${statusColor}`}>
                ESTADO eSIM: <strong>{statusLabel}</strong>
              </span>
              <p className="font-mono text-[10px] text-textsecondary mt-0.5">
                {mission.destination.flag} {mission.destination.name} · {mission.destination.coverage} · {mission.channelId}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 font-mono text-xs text-textsecondary">
            <span>{fmtDate(mission.startDate)} → {fmtDate(mission.endDate)}</span>
            <span className="hidden sm:inline">RED STELLAR TESTNET</span>
          </div>
        </div>

        {/* Hero metrics grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <MetricCard
            label="SALDO"
            value={`${fmtUsdc(mission.balanceUsdc, 4)} USDC`}
            icon="account_balance_wallet"
            iconColor="text-primaryviolet"
            highlight={mission.alertAt20pct && pctRemaining < 20}
          />
          <MetricCard
            label="CONSUMIDO"
            value={`${fmtUsdc(mission.consumedUsdc, 4)} USDC`}
            icon="bolt"
            iconColor="text-tealbrand"
          />
          <MetricCard
            label="DATOS"
            value={fmtMb(mission.consumedMb)}
            icon="wifi_tethering"
            iconColor="text-primaryviolet"
          />
          <MetricCard
            label="DÍAS RESTANTES"
            value={`${Math.max(0, mission.durationDays)} días`}
            icon="calendar_month"
            iconColor="text-stellar"
          />
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* Left column */}
          <div className="lg:col-span-4 flex flex-col gap-6">

            {/* Gauge */}
            <ConsumptionGauge
              consumedMb={mission.consumedMb}
              budgetUsdc={mission.budgetUsdc}
              balanceUsdc={mission.balanceUsdc}
            />

            {/* Budget bar */}
            <div className="p-5 rounded-2xl bg-white border border-cardborder shadow-sm flex flex-col gap-3">
              <div className="flex items-center justify-between font-mono text-[11px] font-bold text-textsecondary uppercase tracking-widest">
                <span>PRESUPUESTO</span>
                <span className="text-primaryviolet">{pctRemaining.toFixed(0)}% RESTANTE</span>
              </div>
              <div className="h-3 bg-cardborder rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primaryviolet to-tealbrand transition-all duration-500"
                  style={{ width: `${pctRemaining}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs font-mono text-textsecondary">
                <span>0 USDC</span>
                <span>{fmtUsdc(mission.budgetUsdc, 2)} USDC</span>
              </div>
              <div className="flex items-center justify-between text-xs font-mono pt-1">
                <span className="text-textsecondary">LÍMITE DIARIO</span>
                <span className="text-tealbrand font-bold">{fmtUsdc(mission.dailyLimitUsdc, 2)} USDC/día</span>
              </div>
            </div>

            {/* Ship / copilot */}
            <div className="p-5 rounded-2xl bg-primaryviolet-light border border-primaryviolet/20 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-primaryviolet font-mono text-xs font-bold tracking-wider uppercase">
                <span className="material-symbols-outlined text-base">smart_toy</span>
                COPILOTO AI
              </div>
              <div className="flex items-start gap-3">
                <div className={`w-12 h-12 shrink-0 animate-float-ship ${flash ? 'scale-110' : ''} transition-transform`}>
                  <img src={shipSrc} alt="Nave" className="w-full h-full object-contain drop-shadow-[0_4px_12px_rgba(105,65,255,0.3)]" />
                </div>
                <p className="text-xs text-textprimary italic leading-relaxed">
                  {isCompleted
                    ? '"Misión completada. El saldo no consumido ha sido liberado a tu wallet. Hasta la próxima partida."'
                    : isPaused
                      ? '"Los datos están pausados. Recargá saldo o reanudá cuando estés listo para continuar."'
                      : pctRemaining < 20
                        ? `"¡Atención! Queda menos del 20% de tu presupuesto. Considerá recargar saldo antes de quedarte sin datos."`
                        : `"Tu misión está dentro del presupuesto. Disponés de aproximadamente ${fmtMb(mission.consumedMb)} de datos en ${mission.destination.name}. Navegando en modo óptimo."`
                  }
                </p>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="lg:col-span-8 flex flex-col gap-6">

            {/* Action buttons */}
            {!isCompleted && (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={isPaused}
                  onClick={handleSimulate}
                  className="flex-1 min-w-[160px] py-3.5 rounded-full bg-primaryviolet text-white font-sans font-semibold text-sm uppercase tracking-wider shadow-[0_4px_14px_rgba(105,65,255,0.3)] hover:bg-primaryviolet-hover hover:shadow-[0_6px_20px_rgba(105,65,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">bolt</span>
                  INYECTAR TRÁFICO DE PRUEBA
                </button>

                <button
                  type="button"
                  onClick={() => setShowTopUp(true)}
                  className="flex-1 min-w-[160px] py-3.5 rounded-full border border-cardborder bg-white text-textprimary font-sans font-semibold text-sm uppercase tracking-wider hover:bg-bglight hover:border-tealbrand/40 hover:text-tealbrand shadow-sm transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">add_circle</span>
                  RECARGAR SALDO
                </button>

                <button
                  type="button"
                  onClick={togglePause}
                  className={`flex-1 min-w-[160px] py-3.5 rounded-full border font-sans font-semibold text-sm uppercase tracking-wider transition-all duration-200 flex items-center justify-center gap-2 ${
                    isPaused
                      ? 'border-online/40 bg-online/10 text-online hover:bg-online/20'
                      : 'border-stellar/40 bg-stellar/10 text-textprimary hover:bg-stellar/20'
                  }`}
                >
                  <span className="material-symbols-outlined text-base">{isPaused ? 'play_circle' : 'pause_circle'}</span>
                  {isPaused ? 'REANUDAR' : 'PAUSAR DATOS'}
                </button>

                <button
                  type="button"
                  onClick={() => setShowCompleteConfirm(true)}
                  className="flex-1 min-w-[160px] py-3.5 rounded-full border border-alerta/30 bg-alerta/5 text-alerta font-sans font-semibold text-sm uppercase tracking-wider hover:bg-alerta/10 transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">flag</span>
                  FINALIZAR MISIÓN
                </button>
              </div>
            )}

            {/* Completed state */}
            {isCompleted && (
              <div className="flex flex-col sm:flex-row gap-3">
                <a
                  href="/mission/new"
                  className="flex-1 py-3.5 rounded-full bg-primaryviolet text-white font-sans font-bold text-sm uppercase tracking-wider text-center shadow-[0_4px_14px_rgba(105,65,255,0.3)] hover:bg-primaryviolet-hover transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">rocket_launch</span>
                  NUEVA MISIÓN
                </a>
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex-1 py-3.5 rounded-full border border-cardborder bg-white text-textsecondary font-sans font-semibold text-sm uppercase tracking-wider hover:bg-bglight transition-all duration-200"
                >
                  REINICIAR DEMO
                </button>
              </div>
            )}

            {/* Activity feed */}
            <div className="bg-white rounded-2xl border border-cardborder shadow-sm p-5 sm:p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-bold text-textprimary uppercase tracking-widest">ACTIVIDAD</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primaryviolet-light border border-primaryviolet/20 font-mono text-[9px] font-bold text-primaryviolet">
                    {events.length} OPS
                  </span>
                </div>
                <span className="font-mono text-[10px] text-textsecondary">Stellar Testnet</span>
              </div>
              <ActivityFeed events={events} />
            </div>

            {/* Technical panel */}
            <div className="p-5 rounded-2xl bg-white border border-cardborder shadow-sm">
              <span className="font-mono text-[11px] font-bold text-textsecondary uppercase tracking-widest block mb-4">
                PANEL TÉCNICO
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 font-mono text-[10px]">
                <TechRow label="CANAL" value={mission.channelId} />
                <TechRow label="RED" value="Stellar Testnet" />
                <TechRow label="PROTOCOLO" value="MPP / Soroban (Mock)" />
                <TechRow label="eSIM" value={mission.esimStatus.toUpperCase()} />
                <TechRow label="PROVEEDOR" value="Telnyx (Simulado)" />
                <TechRow label="MODO" value="Simulación Frontend" />
              </div>
            </div>

          </div>
        </div>
      </main>
    </div>
  )
}

function MetricCard({
  label,
  value,
  icon,
  iconColor,
  highlight,
}: {
  label: string
  value: string
  icon: string
  iconColor: string
  highlight?: boolean
}) {
  return (
    <div className={`p-4 rounded-2xl border shadow-sm flex flex-col gap-2 transition-all ${highlight ? 'bg-stellar/10 border-stellar/30' : 'bg-white border-cardborder'}`}>
      <div className="flex items-center gap-1.5">
        <span className={`material-symbols-outlined text-base ${iconColor}`}>{icon}</span>
        <span className="font-mono text-[10px] font-bold text-textsecondary uppercase tracking-wider">{label}</span>
      </div>
      <span className="font-display text-lg font-bold text-textprimary leading-tight">{value}</span>
    </div>
  )
}

function TechRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-textsecondary/60 uppercase tracking-wider">{label}</span>
      <span className="font-bold text-textprimary truncate">{value}</span>
    </div>
  )
}
