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
import type { FinishResult } from '../types/mission'

export default function ActiveMissionPage() {
  const navigate = useNavigate()
  const {
    mission,
    events,
    caps,
    actionLoading,
    isDemoMode,
    simulate,
    togglePause,
    finish,
    reset,
  } = useMission()

  const [showTopUp, setShowTopUp] = useState(false)
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false)
  const [finishResult, setFinishResult] = useState<FinishResult | null>(null)
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Redirect if no mission
  useEffect(() => {
    if (!mission && !isDemoMode) {
      navigate('/mission/new', { replace: true })
    }
  }, [mission, isDemoMode, navigate])

  if (!mission) return null

  const isPaused = mission.esimStatus === 'paused' || mission.status === 'paused'
  const isClosing = mission.status === 'closing' || mission.status === 'refund_pending'
  const isCompleted = mission.status === 'completed'
  const pctRemaining = mission.budgetUsdc > 0
    ? (mission.balanceUsdc / mission.budgetUsdc) * 100
    : 0

  function handleSimulate() {
    setFlash(true)
    void simulate()
    setTimeout(() => setFlash(false), 400)
  }

  async function handleCompleteSubmit() {
    setError(null)
    try {
      const res = await finish()
      setFinishResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al finalizar la misión')
    }
  }

  function handleReset() {
    reset()
    navigate('/', { replace: true })
  }

  const statusColor = isCompleted
    ? 'text-textsecondary'
    : isClosing
      ? 'text-amber-500'
      : isPaused
        ? 'text-stellar'
        : 'text-online'

  const statusLabel = isCompleted
    ? 'MISIÓN FINALIZADA'
    : isClosing
      ? 'LIQUIDANDO Y REINTEGRANDO SALDO'
      : isPaused
        ? 'DATOS PAUSADOS'
        : 'CONEXIÓN ACTIVA'

  const providerLabel = isDemoMode || mission.isMock !== false ? 'Citrus Mobile (Simulado)' : 'Citrus Mobile'
  const iccidDisplay = mission.iccid || mission.esim?.iccid || 'iccid_unknown'

  return (
    <div className="min-h-screen bg-bglight relative overflow-x-hidden">
      {/* Background grid */}
      <div className="fixed inset-0 fintech-grid opacity-50 pointer-events-none" />

      {/* Glows */}
      <div className="fixed top-0 -left-32 w-72 h-72 bg-primaryviolet/8 rounded-full blur-[100px] pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-64 h-64 bg-tealbrand/8 rounded-full blur-[80px] pointer-events-none" />

      {/* Top-up modal */}
      {showTopUp && (
        <TopUpModal onClose={() => setShowTopUp(false)} />
      )}

      {/* Finish / Complete Modal */}
      {showCompleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-textprimary/20 backdrop-blur-sm"
            onClick={() => !actionLoading && setShowCompleteConfirm(false)}
          />
          <div className="relative z-10 w-full max-w-md max-h-[90vh] overflow-y-auto bg-white rounded-3xl border border-cardborder shadow-[0_20px_60px_rgba(25,24,29,0.12)] p-6 sm:p-7 flex flex-col gap-5">
            {!finishResult ? (
              <>
                <h3 className="font-display text-xl font-bold text-textprimary">¿Finalizar misión?</h3>
                <p className="text-sm text-textsecondary leading-relaxed">
                  Tu eSIM se desactivará, se calculará el consumo final y se reembolsará el saldo remanente a tu wallet vía Soroban.
                </p>
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={() => setShowCompleteConfirm(false)}
                    className="flex-1 py-3 rounded-full border border-cardborder bg-white text-textsecondary font-sans font-semibold text-xs uppercase tracking-wider hover:bg-bglight transition-all"
                  >
                    CANCELAR
                  </button>
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={() => void handleCompleteSubmit()}
                    className="flex-1 py-3 rounded-full bg-alerta text-white font-sans font-bold text-xs uppercase tracking-wider hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-1.5"
                  >
                    {actionLoading && <span className="material-symbols-outlined text-sm animate-spin">refresh</span>}
                    FINALIZAR MISIÓN
                  </button>
                </div>
              </>
            ) : (
              /* Finish Result Screen */
              <div className="flex flex-col gap-4 font-mono text-xs">
                <div className="flex items-center gap-2 text-tealbrand">
                  <span className="material-symbols-outlined text-2xl">task_alt</span>
                  <h4 className="font-bold text-sm uppercase">PROCESO DE CIERRE INICIADO</h4>
                </div>
                <div className="bg-bglight p-4 rounded-2xl border border-cardborder flex flex-col gap-2">
                  <div className="flex justify-between">
                    <span className="text-textsecondary">ESTADO CIERRE:</span>
                    <span className="font-bold text-textprimary uppercase">{finishResult.status}</span>
                  </div>
                  {finishResult.txHash && (
                    <div className="flex justify-between">
                      <span className="text-textsecondary">TX CIERRE:</span>
                      <span className="font-bold text-primaryviolet text-[10px] break-all">{finishResult.txHash}</span>
                    </div>
                  )}
                </div>
                <p className="font-sans text-xs text-textsecondary">
                  {finishResult.status === 'completed'
                    ? 'El proceso ha finalizado y el saldo sobrante fue liberado.'
                    : 'La devolución (defund) está siendo procesada en segundo plano por el proveedor Citrus y Soroban.'}
                </p>
                <button
                  type="button"
                  onClick={() => setShowCompleteConfirm(false)}
                  className="w-full py-3 rounded-full bg-primaryviolet text-white font-bold text-xs uppercase tracking-wider hover:bg-primaryviolet-hover transition-all"
                >
                  CERRAR VENTANA
                </button>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-xl bg-alerta/10 border border-alerta/20 font-mono text-xs text-alerta">
                {error}
              </div>
            )}
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
              {isDemoMode ? 'REINICIAR DEMO' : 'CERRAR SESIÓN'}
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-8">

        {/* Status bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-8 p-4 sm:p-5 rounded-2xl bg-white border border-cardborder shadow-sm">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full ${isCompleted ? 'bg-textsecondary/40' : isClosing ? 'bg-amber-500 animate-pulse' : isPaused ? 'bg-stellar animate-pulse' : 'bg-online animate-pulse'}`} />
            <div>
              <span className={`font-mono text-xs font-bold tracking-wider uppercase ${statusColor}`}>
                ESTADO eSIM: <strong>{statusLabel}</strong>
              </span>
              <p className="font-mono text-[10px] text-textsecondary mt-0.5">
                {mission.destination.flag} {mission.destination.name} · {mission.destination.coverage} · {mission.channelId || 'CANAL EN PROCESO'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 font-mono text-xs text-textsecondary">
            <span>{fmtDate(mission.startDate)} → {fmtDate(mission.endDate)}</span>
            <span className="hidden sm:inline">RED STELLAR {caps?.network ? caps.network.toUpperCase() : 'TESTNET'}</span>
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
            label="DATOS EST."
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
                    : isClosing
                      ? '"Proceso de cierre en curso. Liquidando consumo final con Citrus y Soroban."'
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
            {!isCompleted && !isClosing && (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={isPaused || actionLoading}
                  onClick={handleSimulate}
                  className="flex-1 min-w-[160px] py-3.5 rounded-full bg-primaryviolet text-white font-sans font-semibold text-sm uppercase tracking-wider shadow-[0_4px_14px_rgba(105,65,255,0.3)] hover:bg-primaryviolet-hover hover:shadow-[0_6px_20px_rgba(105,65,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">bolt</span>
                  INYECTAR TRÁFICO
                </button>

                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => setShowTopUp(true)}
                  className="flex-1 min-w-[160px] py-3.5 rounded-full border border-cardborder bg-white text-textprimary font-sans font-semibold text-sm uppercase tracking-wider hover:bg-bglight hover:border-tealbrand/40 hover:text-tealbrand shadow-sm disabled:opacity-40 transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">add_circle</span>
                  RECARGAR SALDO
                </button>

                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => void togglePause()}
                  className={`flex-1 min-w-[160px] py-3.5 rounded-full border font-sans font-semibold text-sm uppercase tracking-wider transition-all duration-200 flex items-center justify-center gap-2 ${
                    isPaused
                      ? 'border-online/40 bg-online/10 text-online hover:bg-online/20'
                      : 'border-stellar/40 bg-stellar/10 text-textprimary hover:bg-stellar/20'
                  }`}
                >
                  {actionLoading ? (
                    <span className="material-symbols-outlined text-base animate-spin">refresh</span>
                  ) : (
                    <span className="material-symbols-outlined text-base">{isPaused ? 'play_circle' : 'pause_circle'}</span>
                  )}
                  {isPaused ? 'REANUDAR' : 'PAUSAR DATOS'}
                </button>

                <button
                  type="button"
                  disabled={actionLoading}
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
                  {isDemoMode ? 'REINICIAR DEMO' : 'CERRAR SESIÓN'}
                </button>
              </div>
            )}

            {/* Citrus eSIM Dedicated Card */}
            <div className="bg-white rounded-2xl border border-cardborder shadow-sm p-5 sm:p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primaryviolet text-xl">sim_card</span>
                  <span className="font-mono text-[11px] font-bold text-textprimary uppercase tracking-widest">CITRUS MOBILE eSIM</span>
                </div>
                <span className="px-2.5 py-0.5 rounded-full bg-online/10 text-online border border-online/20 font-mono text-[9px] font-bold uppercase">
                  {mission.esimStatus}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-[10px] bg-bglight p-3.5 rounded-xl border border-cardborder">
                <TechRow label="PROVEEDOR" value={providerLabel} />
                <TechRow label="ICCID" value={iccidDisplay} />
                <TechRow label="WALLET CITRUS" value={`${fmtUsdc(mission.balanceUsdc, 2)} USD`} />
                <TechRow label="ESTADO PROVEEDOR" value={mission.esimStatus.toUpperCase()} />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <p className="font-sans text-xs text-textsecondary">
                  Perfil de datos eSIM administrado vía wallet Soroban en tiempo real.
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/mission/esim')}
                  className="px-4 py-2 rounded-full border border-primaryviolet/30 bg-primaryviolet-light text-primaryviolet font-mono text-xs font-bold uppercase tracking-wider hover:bg-primaryviolet hover:text-white transition-all flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-sm">qr_code_2</span>
                  VER INSTRUCCIONES DE INSTALACIÓN
                </button>
              </div>
            </div>

            {/* Activity feed */}
            <div className="bg-white rounded-2xl border border-cardborder shadow-sm p-5 sm:p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-bold text-textprimary uppercase tracking-widest">ACTIVIDAD</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primaryviolet-light border border-primaryviolet/20 font-mono text-[9px] font-bold text-primaryviolet">
                    {events.length} OPS
                  </span>
                </div>
                <span className="font-mono text-[10px] text-textsecondary">
                  Stellar {caps?.network ? caps.network.toUpperCase() : 'Testnet'}
                </span>
              </div>
              <ActivityFeed events={events} />
            </div>

            {/* Technical panel */}
            <div className="p-5 rounded-2xl bg-white border border-cardborder shadow-sm">
              <span className="font-mono text-[11px] font-bold text-textsecondary uppercase tracking-widest block mb-4">
                PANEL TÉCNICO
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 font-mono text-[10px]">
                <TechRow label="CANAL" value={mission.channelId || 'EN PROCESO'} />
                <TechRow label="RED" value={caps?.network || 'Stellar Testnet'} />
                <TechRow label="PROTOCOLO" value="MPP / Soroban" />
                <TechRow label="eSIM" value={mission.esimStatus.toUpperCase()} />
                <TechRow label="PROVEEDOR" value={providerLabel} />
                <TechRow label="MODO" value={isDemoMode ? 'Demo Frontend' : mission.isMock !== false ? 'Mock API' : 'Live API'} />
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
