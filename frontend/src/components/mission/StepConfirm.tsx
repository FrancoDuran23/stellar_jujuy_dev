import { daysBetween, estimateMb, fmtDate, fmtMb } from '../../utils/missionUtils'
import type { WizardData } from '../../types/mission'
import { ORIGIN } from '../../utils/missionUtils'

type Props = {
  data: WizardData
  onBack: () => void
  onConfirm: () => void
}

type RowProps = { label: string; value: string; mono?: boolean; accent?: string }

function Row({ label, value, mono, accent }: RowProps) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-cardborder last:border-0">
      <span className="font-mono text-[11px] font-bold text-textsecondary tracking-widest uppercase">{label}</span>
      <span className={`font-sans text-sm font-semibold ${accent ?? 'text-textprimary'} ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

export default function StepConfirm({ data, onBack, onConfirm }: Props) {
  const { destination, startDate, endDate, budgetUsdc, dailyLimitUsdc } = data
  if (!destination) return null

  const duration = daysBetween(startDate, endDate)
  const estimatedMb = estimateMb(budgetUsdc, destination.pricePerMbUsdc)

  return (
    <div className="flex flex-col gap-6">
      <div className="p-2 rounded-2xl bg-bglight border border-cardborder">
        <Row label="ORIGEN" value={`${ORIGIN.flag} ${ORIGIN.name}`} />
        <Row label="DESTINO" value={`${destination.flag} ${destination.name}`} />
        <Row label="INICIO" value={fmtDate(startDate)} />
        <Row label="FIN" value={fmtDate(endDate)} />
        <Row label="DURACIÓN" value={`${duration} día${duration > 1 ? 's' : ''}`} />
        <Row label="SALDO INICIAL" value={`${budgetUsdc.toFixed(2)} USDC`} accent="text-primaryviolet" />
        <Row label="LÍMITE DIARIO" value={`${dailyLimitUsdc.toFixed(2)} USDC/día`} accent="text-tealbrand" />
        <Row label="PRECIO EST./MB" value={`${(destination.pricePerMbUsdc * 1000).toFixed(1)} mUSDC`} mono />
        <Row label="DATOS EST." value={fmtMb(estimatedMb)} accent="text-tealbrand" />
        <Row label="COBERTURA" value={destination.coverage} />
        <Row label="RED" value="Stellar Testnet" accent="text-primaryviolet" mono />
      </div>

      {/* Options summary */}
      <div className="flex flex-wrap gap-3">
        {data.autoPauseAtLimit && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-tealbrand/10 border border-tealbrand/20 font-mono text-[10px] font-bold text-tealbrand tracking-wider">
            <span className="material-symbols-outlined text-sm">pause_circle</span>
            AUTO-PAUSA ACTIVA
          </span>
        )}
        {data.alertAt20pct && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-stellar/10 border border-stellar/30 font-mono text-[10px] font-bold text-textprimary tracking-wider">
            <span className="material-symbols-outlined text-sm">notifications_active</span>
            ALERTA 20%
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 py-3.5 rounded-full border border-cardborder bg-white text-textprimary font-sans font-semibold text-sm uppercase tracking-wider hover:bg-bglight hover:border-primaryviolet/30 transition-all duration-200"
        >
          EDITAR
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 py-3.5 rounded-full bg-primaryviolet text-white font-sans font-bold text-sm uppercase tracking-wider shadow-[0_4px_16px_rgba(105,65,255,0.35)] hover:bg-primaryviolet-hover hover:shadow-[0_8px_24px_rgba(105,65,255,0.5)] hover:-translate-y-0.5 transition-all duration-200 flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-base">rocket_launch</span>
          CONFIRMAR Y ACTIVAR MISIÓN
        </button>
      </div>
    </div>
  )
}
