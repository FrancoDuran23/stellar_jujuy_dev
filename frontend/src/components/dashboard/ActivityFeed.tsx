import { fmtTime } from '../../utils/missionUtils'
import type { UsageEvent } from '../../types/mission'

type Props = {
  events: UsageEvent[]
}

export default function ActivityFeed({ events }: Props) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <span className="material-symbols-outlined text-3xl text-textsecondary/40">receipt_long</span>
        <p className="font-mono text-xs font-bold text-textsecondary/60 uppercase tracking-widest">
          Sin actividad aún
        </p>
        <p className="text-xs text-textsecondary/40">Simulá consumo para ver los micropagos</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
      {events.map((ev) => {
        const isTopup = ev.mb === 0

        return (
          <div
            key={ev.id}
            className="flex items-center gap-3 p-3 rounded-xl bg-white border border-cardborder hover:border-primaryviolet/20 transition-all"
          >
            {/* Icon */}
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                isTopup ? 'bg-tealbrand/10' : 'bg-primaryviolet-light'
              }`}
            >
              <span
                className={`material-symbols-outlined text-sm ${isTopup ? 'text-tealbrand' : 'text-primaryviolet'}`}
              >
                {isTopup ? 'add_circle' : 'bolt'}
              </span>
            </div>

            {/* Details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-sans text-xs font-semibold text-textprimary">
                  {isTopup ? 'Recarga de saldo' : `${ev.mb.toFixed(1)} MB liquidados`}
                </span>
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-online/10 border border-online/20 font-mono text-[9px] font-bold text-online tracking-wider">
                  LIQUIDADO
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="font-mono text-[10px] text-textsecondary">
                  {fmtTime(ev.timestamp)}
                </span>
                <span className="font-mono text-[10px] font-semibold text-textsecondary/70">
                  {ev.txId.slice(0, 12)}…
                </span>
                <span className="inline-flex items-center gap-0.5 font-mono text-[9px] text-primaryviolet font-medium">
                  Stellar Testnet (Simulado)
                </span>
              </div>
            </div>

            {/* Amount */}
            <span
              className={`font-display text-sm font-bold shrink-0 ${
                isTopup ? 'text-tealbrand' : 'text-textprimary'
              }`}
            >
              {isTopup ? '+' : '-'}
              {ev.amountUsdc.toFixed(4)} USDC
            </span>
          </div>
        )
      })}
    </div>
  )
}
