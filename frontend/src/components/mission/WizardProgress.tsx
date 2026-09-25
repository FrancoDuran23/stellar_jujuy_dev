import type { WizardStep } from '../../types/mission'

type Props = {
  current: WizardStep
  labels: string[]
}

export default function WizardProgress({ current, labels }: Props) {
  const currentLabel = labels[current - 1] || ''

  return (
    <div className="w-full">
      {/* Mobile compact header (Paso X de 4) */}
      <div className="sm:hidden flex flex-col gap-2">
        <div className="flex items-center justify-between font-mono text-xs font-bold">
          <span className="text-primaryviolet">PASO {current} DE {labels.length}</span>
          <span className="text-textsecondary uppercase tracking-wider">{currentLabel}</span>
        </div>
        <div className="w-full h-1.5 bg-cardborder rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primaryviolet to-tealbrand transition-all duration-300"
            style={{ width: `${(current / labels.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Desktop step circles indicator */}
      <div className="hidden sm:flex items-center gap-0">
        {labels.map((label, i) => {
          const step = (i + 1) as WizardStep
          const done = step < current
          const active = step === current

          return (
            <div key={label} className="flex items-center flex-1 last:flex-none">
              {/* Step circle */}
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center font-mono text-xs font-bold transition-all duration-300 ${
                    done
                      ? 'bg-primaryviolet text-white'
                      : active
                        ? 'bg-primaryviolet text-white shadow-[0_0_0_3px_rgba(105,65,255,0.2)]'
                        : 'bg-white border-2 border-cardborder text-textsecondary'
                  }`}
                >
                  {done ? (
                    <span className="material-symbols-outlined text-sm">check</span>
                  ) : (
                    `0${step}`
                  )}
                </div>
                <span
                  className={`text-[10px] font-mono font-bold tracking-wider uppercase whitespace-nowrap ${
                    active ? 'text-primaryviolet' : done ? 'text-textprimary' : 'text-textsecondary'
                  }`}
                >
                  {label}
                </span>
              </div>

              {/* Connector */}
              {i < labels.length - 1 && (
                <div className="flex-1 h-0.5 mx-2 mb-5">
                  <div
                    className={`h-full transition-all duration-500 ${
                      done ? 'bg-primaryviolet' : 'bg-cardborder'
                    }`}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
