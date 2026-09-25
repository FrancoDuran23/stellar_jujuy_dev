import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import logoSrc from '../assets/logo.png'
import WizardProgress from '../components/mission/WizardProgress'
import StepDestination from '../components/mission/StepDestination'
import StepDuration from '../components/mission/StepDuration'
import StepBudget from '../components/mission/StepBudget'
import StepConfirm from '../components/mission/StepConfirm'
import ActivationOverlay from '../components/mission/ActivationOverlay'
import SystemBadge from '../components/SystemBadge'
import { demoMissionService } from '../services/DemoMissionService'
import { addDays, today } from '../utils/missionUtils'
import type { WizardData, WizardStep } from '../types/mission'

const STEP_LABELS = ['DESTINO', 'DURACIÓN', 'PRESUPUESTO', 'CONFIRMAR']

const DEFAULT_DATA: WizardData = {
  destination: null,
  startDate: today(),
  endDate: addDays(today(), 2),
  budgetUsdc: 10,
  dailyLimitUsdc: 3,
  alertAt20pct: true,
  autoPauseAtLimit: true,
}

export default function MissionSetupPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<WizardStep>(1)
  const [data, setData] = useState<WizardData>(DEFAULT_DATA)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update(field: string, value: unknown) {
    setData((prev) => ({ ...prev, [field]: value }))
  }

  function canAdvance(): boolean {
    if (step === 1) return data.destination !== null
    if (step === 2) return data.startDate <= data.endDate
    if (step === 3) {
      const b = data.budgetUsdc
      const d = data.dailyLimitUsdc
      return (
        Number.isFinite(b) &&
        Number.isFinite(d) &&
        !isNaN(b) &&
        !isNaN(d) &&
        b > 0 &&
        d > 0 &&
        d <= b
      )
    }
    return true
  }

  function next() {
    if (step < 4) setStep((prev) => (prev + 1) as WizardStep)
  }

  function back() {
    if (step > 1) setStep((prev) => (prev - 1) as WizardStep)
  }

  async function handleConfirm() {
    setError(null)
    setActivating(true)
    try {
      await demoMissionService.createMission(data)
    } catch (e) {
      setActivating(false)
      setError(e instanceof Error ? e.message : 'Error al crear la misión')
    }
  }

  function handleActivationComplete() {
    navigate('/mission/active')
  }

  return (
    <div className="min-h-screen bg-bglight relative overflow-x-hidden">
      {/* Background grid */}
      <div className="fixed inset-0 fintech-grid opacity-50 pointer-events-none" />

      {/* Activation overlay */}
      {activating && <ActivationOverlay onComplete={handleActivationComplete} />}

      {/* Glows */}
      <div className="fixed top-0 -left-32 w-72 h-72 bg-primaryviolet/8 rounded-full blur-[100px] pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-64 h-64 bg-tealbrand/8 rounded-full blur-[80px] pointer-events-none" />

      {/* Top nav */}
      <header className="relative z-10 w-full bg-white/90 backdrop-blur-md border-b border-cardborder">
        <div className="max-w-3xl mx-auto h-16 px-6 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3 group">
            <img
              src={logoSrc}
              alt="ASTROAM"
              className="h-7 object-contain group-hover:scale-105 transition-transform"
            />
          </a>
          <SystemBadge />
        </div>
      </header>

      {/* Content */}
      <main className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 py-10">
        {/* Section label */}
        <div className="flex flex-col gap-1 mb-8">
          <span className="font-mono text-[11px] font-bold text-primaryviolet tracking-widest uppercase">
            [ NUEVA MISIÓN // CONFIGURACIÓN ]
          </span>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-textprimary">
            {step === 1 && 'Elegí tu destino'}
            {step === 2 && 'Definí la duración'}
            {step === 3 && 'Configurá tu presupuesto'}
            {step === 4 && 'Confirmá la misión'}
          </h1>
        </div>

        {/* Wizard progress */}
        <div className="mb-10">
          <WizardProgress current={step} labels={STEP_LABELS} />
        </div>

        {/* Step content */}
        <div className="bg-white rounded-3xl border border-cardborder shadow-sm p-6 sm:p-8">
          {step === 1 && (
            <StepDestination
              selected={data.destination}
              onSelect={(d) => update('destination', d)}
            />
          )}
          {step === 2 && (
            <StepDuration
              startDate={data.startDate}
              endDate={data.endDate}
              onChange={(s, e) => setData((prev) => ({ ...prev, startDate: s, endDate: e }))}
            />
          )}
          {step === 3 && data.destination && (
            <StepBudget
              destination={data.destination}
              budgetUsdc={data.budgetUsdc}
              dailyLimitUsdc={data.dailyLimitUsdc}
              alertAt20pct={data.alertAt20pct}
              autoPauseAtLimit={data.autoPauseAtLimit}
              onChange={update}
            />
          )}
          {step === 4 && (
            <StepConfirm
              data={data}
              onBack={back}
              onConfirm={() => void handleConfirm()}
            />
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded-xl bg-alerta/10 border border-alerta/20 font-mono text-xs text-alerta">
              {error}
            </div>
          )}
        </div>

        {/* Navigation (steps 1-3) */}
        {step < 4 && (
          <div className="flex items-center justify-between mt-6">
            <button
              type="button"
              onClick={back}
              disabled={step === 1}
              className="px-6 py-2.5 rounded-full border border-cardborder bg-white text-textsecondary font-sans font-semibold text-sm uppercase tracking-wider hover:bg-bglight hover:border-primaryviolet/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
            >
              ATRÁS
            </button>
            <button
              type="button"
              onClick={next}
              disabled={!canAdvance()}
              className="px-8 py-2.5 rounded-full bg-primaryviolet text-white font-sans font-semibold text-sm uppercase tracking-wider shadow-[0_4px_14px_rgba(105,65,255,0.3)] hover:bg-primaryviolet-hover hover:shadow-[0_6px_20px_rgba(105,65,255,0.4)] hover:-translate-y-0.5 disabled:opacity-40 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none transition-all duration-200 flex items-center gap-2"
            >
              SIGUIENTE
              <span className="material-symbols-outlined text-sm">arrow_forward</span>
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
