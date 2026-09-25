type Props = {
  consumedMb: number
  budgetUsdc: number
  balanceUsdc: number
}

export default function ConsumptionGauge({ consumedMb, budgetUsdc, balanceUsdc }: Props) {
  const pct = budgetUsdc > 0 ? Math.min(100, ((budgetUsdc - balanceUsdc) / budgetUsdc) * 100) : 0
  const remaining = Math.max(0, pct)

  // SVG arc params
  const r = 70
  const cx = 90
  const cy = 90
  const strokeW = 12
  const circumference = Math.PI * r   // semicircle
  const offset = circumference - (remaining / 100) * circumference

  const color = remaining > 80 ? '#E85D5D' : remaining > 50 ? '#FDDA24' : '#6941FF'

  return (
    <div className="flex flex-col items-center gap-4 p-6 rounded-2xl bg-white border border-cardborder shadow-sm">
      <span className="font-mono text-[11px] font-bold text-textsecondary uppercase tracking-widest">
        CONSUMO DE SALDO
      </span>

      {/* Semicircular gauge */}
      <div className="relative w-[180px] h-[100px]">
        <svg width="180" height="100" viewBox="0 0 180 100">
          {/* Background arc */}
          <path
            d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
            fill="none"
            stroke="#E8E5E4"
            strokeWidth={strokeW}
            strokeLinecap="round"
          />
          {/* Progress arc */}
          <path
            d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
            fill="none"
            stroke={color}
            strokeWidth={strokeW}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.6s ease' }}
          />
        </svg>

        {/* Center readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-2 gap-0.5">
          <span className="font-display text-2xl font-bold text-textprimary">{remaining.toFixed(0)}%</span>
          <span className="font-mono text-[10px] text-textsecondary uppercase">CONSUMIDO</span>
        </div>
      </div>

      {/* MB readout */}
      <div className="flex items-baseline gap-1">
        <span className="font-display text-3xl font-bold text-textprimary">{consumedMb.toFixed(1)}</span>
        <span className="font-mono text-sm text-textsecondary">MB</span>
      </div>
    </div>
  )
}
