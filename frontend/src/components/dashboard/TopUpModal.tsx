import { useState } from 'react'

type Props = {
  onTopUp: (amount: number) => void
  onClose: () => void
}

export default function TopUpModal({ onTopUp, onClose }: Props) {
  const [amount, setAmount] = useState(5)

  function handleSubmit() {
    if (amount > 0 && Number.isFinite(amount) && !isNaN(amount)) {
      onTopUp(amount)
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-textprimary/20 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal card */}
      <div className="relative z-10 w-full max-w-sm max-h-[90vh] overflow-y-auto bg-white rounded-3xl border border-cardborder shadow-[0_20px_60px_rgba(25,24,29,0.12)] p-6 sm:p-7 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-xl font-bold text-textprimary">Recargar saldo</h3>
            <p className="text-xs text-textsecondary mt-0.5">Agrega USDC a tu misión activa</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-bglight border border-cardborder flex items-center justify-center hover:bg-cardborder transition-colors"
          >
            <span className="material-symbols-outlined text-sm text-textsecondary">close</span>
          </button>
        </div>

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

        {/* Stellar badge */}
        <div className="flex items-center gap-2 p-3 rounded-xl bg-primaryviolet-light border border-primaryviolet/20">
          <span className="material-symbols-outlined text-sm text-primaryviolet">hub</span>
          <p className="font-mono text-[10px] font-bold text-primaryviolet tracking-wider">
            CUSTODIA EN STELLAR TESTNET — MODO DEMO
          </p>
        </div>

        {/* Confirm */}
        <button
          type="button"
          onClick={handleSubmit}
          className="w-full py-3.5 rounded-full bg-primaryviolet text-white font-sans font-bold text-sm uppercase tracking-wider shadow-[0_4px_16px_rgba(105,65,255,0.35)] hover:bg-primaryviolet-hover hover:shadow-[0_8px_24px_rgba(105,65,255,0.5)] transition-all duration-200 flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-base">add_circle</span>
          CONFIRMAR RECARGA
        </button>
      </div>
    </div>
  )
}
