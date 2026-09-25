import { useEffect, useState } from 'react'
import shipSrc from '../../assets/ship.png'
import type { ActivationStep } from '../../types/mission'

const STEPS: ActivationStep[] = [
  { label: 'Conectando wallet demo (Simulado)', status: 'pending' },
  { label: 'Reservando saldo USDC (Simulado)', status: 'pending' },
  { label: 'Desplegando State Channel Soroban (Simulado)', status: 'pending' },
  { label: 'Aprovisionando perfil eSIM demo', status: 'pending' },
  { label: 'Misión lista (Modo Demo)', status: 'pending' },
]

type Props = {
  onComplete: () => void
}

export default function ActivationOverlay({ onComplete }: Props) {
  const [steps, setSteps] = useState<ActivationStep[]>(STEPS)
  const [currentStep, setCurrentStep] = useState(0)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let idx = 0

    function advance() {
      if (idx >= STEPS.length) {
        setDone(true)
        setTimeout(onComplete, 700)
        return
      }

      // Mark current as running
      setCurrentStep(idx)
      setSteps((prev) =>
        prev.map((s, i) => ({
          ...s,
          status: i < idx ? 'done' : i === idx ? 'running' : 'pending',
        })),
      )

      // After ~900ms, mark as done and advance
      setTimeout(() => {
        setSteps((prev) =>
          prev.map((s, i) => ({
            ...s,
            status: i <= idx ? 'done' : s.status,
          })),
        )
        idx++
        setTimeout(advance, 300)
      }, 900)
    }

    const t = setTimeout(advance, 400)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-[100] bg-white/95 backdrop-blur-md flex items-center justify-center">
      {/* Background grid */}
      <div className="absolute inset-0 fintech-grid opacity-40 pointer-events-none" />

      {/* Orbital glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-gradient-to-tr from-primaryviolet/10 via-tealbrand/5 to-transparent blur-3xl pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center gap-8 px-6 text-center max-w-sm">
        {/* Floating ship */}
        <div className={`w-28 h-28 animate-float-ship transition-all duration-700 ${done ? 'scale-110' : ''}`}>
          <img
            src={shipSrc}
            alt="Nave ASTROAM"
            className="w-full h-full object-contain drop-shadow-[0_12px_28px_rgba(105,65,255,0.4)]"
          />
        </div>

        {/* Title */}
        <div className="flex flex-col items-center gap-1">
          <span className="inline-block px-2.5 py-0.5 rounded-full bg-stellar/20 border border-stellar/40 font-mono text-[10px] font-bold text-textprimary tracking-wider uppercase mb-1">
            SIMULACIÓN FRONTEND · MODO DEMO
          </span>
          <span className="font-mono text-[11px] font-bold text-primaryviolet tracking-widest uppercase">
            {done ? '[ MISIÓN ACTIVADA ]' : '[ SECUENCIA DE ACTIVACIÓN ]'}
          </span>
          <h2 className="font-display text-2xl font-bold text-textprimary">
            {done ? 'Todo listo para despegar' : 'Preparando tu misión…'}
          </h2>
        </div>

        {/* Steps */}
        <div className="w-full flex flex-col gap-3">
          {steps.map((step, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all duration-300 ${
                step.status === 'done'
                  ? 'bg-primaryviolet-light border-primaryviolet/30'
                  : step.status === 'running'
                    ? 'bg-white border-primaryviolet/40 shadow-sm'
                    : 'bg-bglight border-cardborder opacity-50'
              }`}
            >
              {/* Icon */}
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 ${
                  step.status === 'done'
                    ? 'bg-primaryviolet'
                    : step.status === 'running'
                      ? 'bg-white border-2 border-primaryviolet'
                      : 'bg-cardborder'
                }`}
              >
                {step.status === 'done' ? (
                  <span className="material-symbols-outlined text-white text-sm">check</span>
                ) : step.status === 'running' ? (
                  <span className="w-2.5 h-2.5 rounded-full bg-primaryviolet animate-pulse" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-textsecondary/30" />
                )}
              </div>

              <span
                className={`font-sans text-sm font-medium ${
                  step.status === 'done'
                    ? 'text-primaryviolet font-semibold'
                    : step.status === 'running'
                      ? 'text-textprimary font-semibold'
                      : 'text-textsecondary'
                }`}
              >
                {step.label}
              </span>

              {step.status === 'running' && (
                <span className="ml-auto font-mono text-[10px] text-primaryviolet animate-pulse">···</span>
              )}
            </div>
          ))}
        </div>

        {/* Progress bar */}
        <div className="w-full h-1 bg-cardborder rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primaryviolet to-tealbrand transition-all duration-500"
            style={{ width: `${((currentStep + (done ? 1 : 0)) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>
    </div>
  )
}
