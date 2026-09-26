import { addDays, daysBetween, fmtDate, today } from '../../utils/missionUtils'

type Props = {
  startDate: string
  endDate: string
  onChange: (start: string, end: string) => void
}

const QUICK = [
  { label: '1 DÍA', days: 1 },
  { label: '3 DÍAS', days: 3 },
  { label: '7 DÍAS', days: 7 },
]

export default function StepDuration({ startDate, endDate, onChange }: Props) {
  const duration = daysBetween(startDate, endDate)
  const todayStr = today()

  function setQuick(days: number) {
    const start = todayStr
    const end = addDays(start, days - 1)
    onChange(start, end)
  }

  function handleStart(val: string) {
    // If end < new start, bump end to start
    if (endDate < val) onChange(val, val)
    else onChange(val, endDate)
  }

  function handleEnd(val: string) {
    if (val < startDate) return
    onChange(startDate, val)
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Quick selectors */}
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[11px] font-bold text-textsecondary tracking-widest uppercase">
          DURACIÓN RÁPIDA
        </span>
        <div className="flex flex-wrap gap-3">
          {QUICK.map(({ label, days }) => {
            const active = duration === days
            return (
              <button
                key={label}
                type="button"
                onClick={() => setQuick(days)}
                className={`px-5 py-2.5 rounded-full font-mono text-xs font-bold tracking-widest transition-all duration-200 ${
                  active
                    ? 'bg-primaryviolet text-white shadow-[0_4px_12px_rgba(105,65,255,0.3)]'
                    : 'bg-white border border-cardborder text-textsecondary hover:border-primaryviolet/40 hover:text-primaryviolet'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Date pickers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <label className="font-mono text-[11px] font-bold text-textsecondary tracking-widest uppercase">
            FECHA DE INICIO
          </label>
          <input
            type="date"
            value={startDate}
            min={todayStr}
            onChange={(e) => handleStart(e.target.value)}
            className="h-12 px-4 rounded-xl border border-cardborder bg-white font-mono text-sm text-textprimary focus:outline-none focus:border-primaryviolet focus:ring-2 focus:ring-primaryviolet/15 transition-all"
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="font-mono text-[11px] font-bold text-textsecondary tracking-widest uppercase">
            FECHA DE FINALIZACIÓN
          </label>
          <input
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => handleEnd(e.target.value)}
            className="h-12 px-4 rounded-xl border border-cardborder bg-white font-mono text-sm text-textprimary focus:outline-none focus:border-primaryviolet focus:ring-2 focus:ring-primaryviolet/15 transition-all"
          />
        </div>
      </div>

      {/* Duration summary */}
      <div className="flex items-center gap-4 p-5 rounded-2xl bg-primaryviolet-light border border-primaryviolet/20">
        <div className="w-12 h-12 rounded-full bg-primaryviolet flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-white text-xl">calendar_month</span>
        </div>
        <div>
          <p className="font-display text-2xl font-bold text-textprimary">
            {duration} {duration === 1 ? 'día' : 'días'}
          </p>
          <p className="text-sm text-textsecondary">
            {fmtDate(startDate)} → {fmtDate(endDate)}
          </p>
        </div>
      </div>
    </div>
  )
}
