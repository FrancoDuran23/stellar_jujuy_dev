import { useState } from 'react'
import { useMission } from '../../hooks/useMission'
import type { PaymentIntentInfo } from '../../types/mission'

type Props = {
  onClose: () => void
}

export default function TopUpModal({ onClose }: Props) {
  const { isDemoMode, createTopUpIntent, confirmTopUpPayment, actionLoading } = useMission()
  const [amount, setAmount] = useState(5)
  const [intent, setIntent] = useState<PaymentIntentInfo | null>(null)
  const [txHashInput, setTxHashInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleStartTopUp() {
    setError(null)
    try {
      if (isDemoMode) {
        await confirmTopUpPayment(`intent_demo_${Date.now()}`, `tx_${Date.now()}`, amount)
        onClose()
      } else {
        const topIntent = await createTopUpIntent(amount)
        setIntent(topIntent)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al solicitar recarga')
    }
  }

  async function handleConfirmTopUp() {
    if (!intent) return
    setError(null)
    try {
      const txHash = txHashInput.trim() || `tx_${Date.now().toString(16)}`
      await confirmTopUpPayment(intent.intentId, txHash, amount)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al confirmar pago de recarga')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-textprimary/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal / Bottom-sheet card */}
      <div className="relative z-10 w-full max-w-md max-h-[85vh] sm:max-h-[90vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl border border-cardborder shadow-[0_-10px_40px_rgba(25,24,29,0.15)] sm:shadow-[0_20px_60px_rgba(25,24,29,0.12)] p-6 sm:p-7 flex flex-col gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 bg-cardborder rounded-full mx-auto -mt-2 mb-1 sm:hidden" />

        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-xl font-bold text-textprimary">Recargar saldo</h3>
            <p className="text-xs text-textsecondary mt-0.5">Agregá USDC a tu misión activa vía CosmoPay</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-bglight border border-cardborder flex items-center justify-center hover:bg-cardborder transition-colors"
          >
            <span className="material-symbols-outlined text-sm text-textsecondary">close</span>
          </button>
        </div>

        {!intent ? (
          <>
            {/* Amount selector */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label className="font-mono text-[11px] font-bold text-textsecondary tracking-widest uppercase">
                  IMPORTE
                </label>
                <span className="font-display text-2xl font-bold text-primaryviolet">
                  {amount.toFixed(2)} USDC
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={50}
                step={0.5}
                value={amount}
                onChange={(e) => setAmount(parseFloat(e.target.value))}
                className="w-full accent-primaryviolet"
              />
              <div className="flex justify-between font-mono text-[10px] text-textsecondary">
                <span>1 USDC</span>
                <span>50 USDC</span>
              </div>

              {/* Quick amounts */}
              <div className="flex gap-2 pt-1">
                {[5, 10, 20].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(v)}
                    className={`flex-1 py-2 rounded-xl font-mono text-xs font-bold tracking-wider border transition-all ${
                      amount === v
                        ? 'bg-primaryviolet text-white border-primaryviolet'
                        : 'bg-bglight border-cardborder text-textsecondary hover:border-primaryviolet/40'
                    }`}
                  >
                    {v} USDC
                  </button>
                ))}
              </div>
            </div>

            {/* Badge */}
            <div className="flex items-center gap-2 p-3 rounded-xl bg-primaryviolet-light border border-primaryviolet/20">
              <span className="material-symbols-outlined text-sm text-primaryviolet">hub</span>
              <p className="font-mono text-[10px] font-bold text-primaryviolet tracking-wider">
                {isDemoMode ? 'CUSTODIA STELLAR — MODO DEMO' : 'DEPÓSITO DE RECARGA COSMOPAY'}
              </p>
            </div>

            {/* Confirm */}
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void handleStartTopUp()}
              className="w-full py-3.5 rounded-full bg-primaryviolet text-white font-sans font-bold text-sm uppercase tracking-wider shadow-[0_4px_16px_rgba(105,65,255,0.35)] hover:bg-primaryviolet-hover disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-base">add_circle</span>
              {isDemoMode ? 'CONFIRMAR RECARGA (DEMO)' : 'GENERAR INTENCIÓN DE PAGO'}
            </button>
          </>
        ) : (
          /* Payment Intent Step in API Mode */
          <div className="flex flex-col gap-4 font-mono text-xs">
            <div className="p-4 bg-bglight rounded-2xl border border-cardborder text-center">
              <span className="text-textsecondary text-[10px] block mb-1">PAGÁ TU RECARGA DE</span>
              <span className="font-display text-xl font-bold text-primaryviolet">{intent.amount} {intent.asset}</span>
              {intent.qr && (
                <img src={intent.qr} alt="QR Recarga" className="w-36 h-36 mx-auto my-3 object-contain rounded-lg" />
              )}
            </div>

            {intent.sep7Uri && (
              <a
                href={intent.sep7Uri}
                target="_blank"
                rel="noreferrer"
                className="py-2.5 px-4 rounded-xl bg-primaryviolet text-white text-center font-bold text-xs uppercase tracking-wider hover:bg-primaryviolet-hover transition-all"
              >
                ABRIR WALLET (SEP-7)
              </a>
            )}

            <div>
              <label className="block text-[11px] text-textsecondary mb-1">HASH DE TRANSACCIÓN</label>
              <input
                type="text"
                value={txHashInput}
                onChange={(e) => setTxHashInput(e.target.value)}
                placeholder="0xtx_hash..."
                className="w-full px-3 py-2 rounded-xl border border-cardborder text-xs text-textprimary focus:outline-none focus:border-primaryviolet"
              />
            </div>

            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void handleConfirmTopUp()}
              className="w-full py-3 rounded-full bg-tealbrand text-white font-bold text-xs uppercase tracking-wider hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
              {actionLoading ? (
                <span className="material-symbols-outlined text-sm animate-spin">refresh</span>
              ) : (
                <span className="material-symbols-outlined text-sm">check_circle</span>
              )}
              CONFIRMAR RECARGA EN SERVIDOR
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
  )
}
