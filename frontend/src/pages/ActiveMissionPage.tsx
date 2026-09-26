import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import shipSrc from '../assets/ship.png'
import MobileAppShell from '../components/MobileAppShell'
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
  const [showTechDetails, setShowTechDetails] = useState(false)

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

  function scrollToActivity() {
    const el = document.getElementById('activity-feed')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
    } else {
      window.scrollTo({ top: 900, behavior: 'smooth' })
    }
  }

  return (
    <MobileAppShell
      title="MISIÓN ACTIVA"
      onActivityClick={scrollToActivity}
      showBottomNav={!showCompleteConfirm}
    >
      {/* Top-up modal */}
      {showTopUp && (
        <TopUpModal onClose={() => setShowTopUp(false)} />
      )}

      {/* Finish / Complete Modal */}
      {showCompleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div
            className="absolute inset-0 bg-textprimary/30 backdrop-blur-sm"
            onClick={() => !actionLoading && setShowCompleteConfirm(false)}
          />
          <div className="relative z-10 w-full max-w-md max-h-[85vh] sm:max-h-[90vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl border border-cardborder shadow-[0_20px_60px_rgba(25,24,29,0.12)] p-6 sm:p-7 flex flex-col gap-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <div className="w-12 h-1.5 bg-cardborder rounded-full mx-auto -mt-2 mb-1 sm:hidden" />
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
                    className="flex-1 py-3 rounded-full border border-cardborder bg-white text-textsecondary font-sans font-semibold text-xs uppercase tracking-wider hover:bg-bglight transition-all min-h-[44px]"
                  >
                    CANCELAR
                  </button>
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={() => void handleCompleteSubmit()}
                    className="flex-1 py-3 rounded-full bg-alerta text-white font-sans font-bold text-xs uppercase tracking-wider hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-1.5 min-h-[44px]"
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
                  className="w-full py-3.5 rounded-full bg-primaryviolet text-white font-bold text-xs uppercase tracking-wider hover:bg-primaryviolet-hover transition-all min-h-[44px]"
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

      {/* 1. Main status card (Hero status) */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 p-4 sm:p-5 rounded-2xl bg-white border border-cardborder shadow-sm">
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full ${isCompleted ? 'bg-textsecondary/40' : isClosing ? 'bg-amber-500 animate-pulse' : isPaused ? 'bg-stellar animate-pulse' : 'bg-online animate-pulse'}`} />
          <div>
            <span className={`font-mono text-xs font-bold tracking-wider uppercase ${statusColor}`}>
              {statusLabel}
            </span>
            <p className="font-mono text-xs text-textsecondary mt-0.5">
              {mission.destination.flag} {mission.destination.name} · {mission.destination.coverage}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-textsecondary">
          <span>{fmtDate(mission.startDate)} → {fmtDate(mission.endDate)}</span>
          <span className="hidden sm:inline">RED STELLAR {caps?.network ? caps.network.toUpperCase() : 'TESTNET'}</span>
        </div>
      </div>

      {/* 2. Dominant Balance Card */}
      <div className="p-6 rounded-3xl bg-white border border-cardborder shadow-sm mb-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs font-bold text-textsecondary tracking-widest uppercase">
            SALDO DISPONIBLE
          </span>
          <span className="px-2.5 py-1 rounded-full text-xs font-mono font-bold bg-primaryviolet-light text-primaryviolet border border-primaryviolet/20">
            {pctRemaining.toFixed(0)}% RESTANTE
          </span>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="font-display text-4xl sm:text-5xl font-bold text-primaryviolet tracking-tight">
            {fmtUsdc(mission.balanceUsdc, 2)}
          </span>
          <span className="font-mono text-lg font-bold text-textsecondary">USDC</span>
        </div>

        {/* Budget progress bar */}
        <div className="h-3 bg-cardborder rounded-full overflow-hidden my-1">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primaryviolet via-tealbrand to-stellar transition-all duration-500"
            style={{ width: `${pctRemaining}%` }}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-cardborder/60 font-mono text-xs">
          <div>
            <span className="text-textsecondary text-[10px] block uppercase">CONSUMIDO</span>
            <span className="font-bold text-textprimary">{fmtUsdc(mission.consumedUsdc, 2)} USDC</span>
          </div>
          <div className="text-right">
            <span className="text-textsecondary text-[10px] block uppercase">PRESUPUESTO TOTAL</span>
            <span className="font-bold text-textprimary">{fmtUsdc(mission.budgetUsdc, 2)} USDC</span>
          </div>
        </div>
      </div>

      {/* 3. Usage & Telemetry Card */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
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
        <MetricCard
          label="LÍMITE DIARIO"
          value={`${fmtUsdc(mission.dailyLimitUsdc, 2)} USDC`}
          icon="timelapse"
          iconColor="text-tealbrand"
        />
        <MetricCard
          label="PROVEEDOR"
          value={isDemoMode ? 'Citrus (Demo)' : 'Citrus Mobile'}
          icon="sim_card"
          iconColor="text-primaryviolet"
        />
      </div>

      {/* 4. Quick Actions Grid 2x2 (min 48px height) */}
      {!isCompleted && !isClosing && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => setShowTopUp(true)}
            className="py-3.5 px-4 rounded-2xl bg-primaryviolet text-white font-sans font-bold text-xs uppercase tracking-wider shadow-[0_4px_14px_rgba(105,65,255,0.3)] hover:bg-primaryviolet-hover transition-all flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span className="material-symbols-outlined text-base">add_circle</span>
            RECARGAR
          </button>

          <button
            type="button"
            disabled={actionLoading}
            onClick={() => void togglePause()}
            className={`py-3.5 px-4 rounded-2xl border font-sans font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 min-h-[48px] ${
              isPaused
                ? 'border-2 border-online bg-online/15 text-online hover:bg-online/25 active:scale-[0.98]'
                : 'border-2 border-amber-500/80 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:border-amber-600 active:scale-[0.98]'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {actionLoading ? (
              <span className="material-symbols-outlined text-base animate-spin">refresh</span>
            ) : (
              <span className="material-symbols-outlined text-base font-bold">{isPaused ? 'play_circle' : 'pause_circle'}</span>
            )}
            {isPaused ? 'REANUDAR' : 'PAUSAR DATOS'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/mission/esim')}
            className="py-3.5 px-4 rounded-2xl border border-cardborder bg-white text-textprimary font-sans font-bold text-xs uppercase tracking-wider hover:bg-bglight transition-all flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span className="material-symbols-outlined text-base">qr_code_2</span>
            VER eSIM
          </button>

          <button
            type="button"
            disabled={isPaused || actionLoading}
            onClick={handleSimulate}
            className="py-3.5 px-4 rounded-2xl border border-cardborder bg-white text-textprimary font-sans font-bold text-xs uppercase tracking-wider hover:bg-bglight disabled:opacity-40 transition-all flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span className="material-symbols-outlined text-base">bolt</span>
            TRÁFICO
          </button>
        </div>
      )}

      {/* 5. Copilot Recommendation Card */}
      <div className="p-5 rounded-2xl bg-primaryviolet-light border border-primaryviolet/20 flex flex-col gap-3 mb-6">
        <div className="flex items-center gap-2 text-primaryviolet font-mono text-xs font-bold tracking-wider uppercase">
          <span className="material-symbols-outlined text-base">smart_toy</span>
          COPILOTO AI
        </div>
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 shrink-0 animate-float-ship ${flash ? 'scale-110' : ''} transition-transform`}>
            <img src={shipSrc} alt="Nave" className="w-full h-full object-contain drop-shadow-[0_4px_12px_rgba(105,65,255,0.3)]" />
          </div>
          <p className="text-xs text-textprimary italic leading-relaxed">
            {isCompleted
              ? '"Misión completada. El saldo no consumido ha sido liberado a tu wallet."'
              : isClosing
                ? '"Proceso de cierre en curso. Liquidando consumo final con Citrus y Soroban."'
                : isPaused
                  ? '"Los datos están pausados. Recargá saldo o reanudá cuando estés listo."'
                  : pctRemaining < 20
                    ? `"¡Atención! Queda menos del 20% de tu presupuesto. Considerá recargar saldo."`
                    : `"Tu misión está dentro del presupuesto. Disponés de aprox. ${fmtMb(mission.consumedMb)} de datos en ${mission.destination.name}."`
            }
          </p>
        </div>
      </div>

      {/* 6. Activity Timeline */}
      <div id="activity-feed" className="bg-white rounded-2xl border border-cardborder shadow-sm p-5 sm:p-6 flex flex-col gap-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-textprimary uppercase tracking-widest">ACTIVIDAD</span>
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

      {/* 7. Collapsible Technical Details */}
      <div className="bg-white rounded-2xl border border-cardborder shadow-sm p-5 mb-6">
        <button
          type="button"
          onClick={() => setShowTechDetails(!showTechDetails)}
          className="w-full flex items-center justify-between font-mono text-xs font-bold text-textsecondary uppercase tracking-widest hover:text-textprimary transition-colors"
        >
          <span>VER DETALLES TÉCNICOS</span>
          <span className="material-symbols-outlined text-base">
            {showTechDetails ? 'expand_less' : 'expand_more'}
          </span>
        </button>

        {showTechDetails && (
          <div className="mt-4 pt-4 border-t border-cardborder grid grid-cols-2 sm:grid-cols-3 gap-3 font-mono text-[10px]">
            <TechRow label="CANAL" value={mission.channelId || 'EN PROCESO'} />
            <TechRow label="RED" value={caps?.network || 'Stellar Testnet'} />
            <TechRow label="PROTOCOLO" value="MPP / Soroban" />
            <TechRow label="eSIM" value={mission.esimStatus.toUpperCase()} />
            <TechRow label="PROVEEDOR" value={providerLabel} />
            <TechRow label="ICCID" value={iccidDisplay} />
            <TechRow label="MODO" value={isDemoMode ? 'Demo Frontend' : mission.isMock !== false ? 'Mock API' : 'Live API'} />
          </div>
        )}
      </div>

      {/* 8. Secondary Destructive Finish Mission Action */}
      {!isCompleted && !isClosing && (
        <div className="pt-2 pb-6 flex justify-center">
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => setShowCompleteConfirm(true)}
            className="w-full sm:w-auto px-8 py-3.5 rounded-full border border-alerta/30 bg-white text-alerta font-sans font-bold text-xs uppercase tracking-wider hover:bg-alerta/10 transition-all flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span className="material-symbols-outlined text-base">flag</span>
            FINALIZAR MISIÓN
          </button>
        </div>
      )}

      {/* Reset/Exit for completed */}
      {isCompleted && (
        <div className="pt-2 pb-6 flex flex-col sm:flex-row gap-3">
          <a
            href="/mission/new"
            className="flex-1 py-3.5 rounded-full bg-primaryviolet text-white font-sans font-bold text-xs uppercase tracking-wider text-center shadow-[0_4px_14px_rgba(105,65,255,0.3)] hover:bg-primaryviolet-hover transition-all min-h-[48px] flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base">rocket_launch</span>
            NUEVA MISIÓN
          </a>
          <button
            type="button"
            onClick={handleReset}
            className="flex-1 py-3.5 rounded-full border border-cardborder bg-white text-textsecondary font-sans font-semibold text-xs uppercase tracking-wider hover:bg-bglight transition-all min-h-[48px]"
          >
            {isDemoMode ? 'REINICIAR DEMO' : 'CERRAR SESIÓN'}
          </button>
        </div>
      )}
    </MobileAppShell>
  )
}

function MetricCard({
  label,
  value,
  icon,
  iconColor,
}: {
  label: string
  value: string
  icon: string
  iconColor: string
}) {
  return (
    <div className="p-4 rounded-2xl bg-white border border-cardborder shadow-sm flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`material-symbols-outlined text-base ${iconColor}`}>{icon}</span>
        <span className="font-mono text-[10px] font-bold text-textsecondary uppercase tracking-wider">{label}</span>
      </div>
      <span className="font-display text-base sm:text-lg font-bold text-textprimary leading-tight">{value}</span>
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
