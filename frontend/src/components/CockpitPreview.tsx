export default function CockpitPreview() {
  return (
    <section id="cabina" className="relative py-24 px-6 md:px-12 bg-white border-t border-cardborder overflow-hidden">
      <div className="max-w-6xl mx-auto flex flex-col gap-12">

        {/* Header */}
        <div className="flex flex-col items-center text-center gap-2">
          <span className="font-mono text-xs font-bold text-primaryviolet uppercase tracking-widest">
            [ CABINA DE NAVEGACIÓN EN TIEMPO REAL ]
          </span>
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-textprimary">
            VENTANA A LA CABINA DE MISIÓN
          </h2>
          <p className="text-base text-textsecondary max-w-xl">
            Monitoreo cristalino de tu enlace de datos sin terminales abarrotadas ni códigos indescifrables.
          </p>
        </div>

        {/* Cockpit panel */}
        <div className="relative rounded-3xl bg-bglight border border-cardborder shadow-[0_12px_36px_rgba(25,24,29,0.06)] overflow-hidden">

          {/* Top bar */}
          <div className="px-8 py-4 border-b border-cardborder flex flex-wrap items-center justify-between gap-4 bg-white">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full bg-online animate-pulse" />
              <span className="font-mono text-xs font-bold text-textprimary uppercase tracking-wider">
                ESTADO eSIM: <strong className="text-online font-bold">CONEXIÓN ACTIVA</strong>
              </span>
            </div>
            <div className="flex items-center gap-6 font-mono text-xs text-textsecondary">
              <span>CANAL: SOROBAN-04</span>
              <span>DESTINO: BRASIL [GIG]</span>
            </div>
          </div>

          {/* Interior */}
          <div className="p-8 md:p-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">

            {/* Left: arc chart */}
            <div className="lg:col-span-7 flex flex-col gap-5">
              <div className="relative h-60 w-full bg-white rounded-2xl border border-cardborder p-6 flex flex-col justify-between overflow-hidden shadow-sm">
                <svg className="absolute inset-0 w-full h-full pointer-events-none" fill="none" viewBox="0 0 450 200">
                  <circle cx="225" cy="180" r="150" stroke="#F4F2F1" strokeWidth="1.5" />
                  {/* Base arc */}
                  <path d="M 75 180 A 150 150 0 0 1 375 180" stroke="#EEE9FF" strokeLinecap="round" strokeWidth="10" />
                  {/* Progress arc */}
                  <path d="M 75 180 A 150 150 0 0 1 190 35" stroke="url(#arcLightGradient)" strokeLinecap="round" strokeWidth="10" />
                  {/* Ship dot */}
                  <circle className="animate-ping" cx="190" cy="35" fill="#6941FF" r="6" />
                  <circle cx="190" cy="35" fill="#FDDA24" r="5" />
                  <defs>
                    <linearGradient gradientUnits="userSpaceOnUse" id="arcLightGradient" x1="75" x2="190" y1="180" y2="35">
                      <stop stopColor="#6941FF" />
                      <stop offset="1" stopColor="#008C99" />
                    </linearGradient>
                  </defs>
                </svg>

                <div className="relative z-10 flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-primaryviolet tracking-wider">TRAYECTORIA EN CURSO</span>
                  <span className="font-mono text-xs font-bold text-tealbrand">40% CONSUMIDO</span>
                </div>
                <div className="relative z-10 flex items-end justify-between pt-10">
                  <div>
                    <span className="font-mono text-[10px] font-semibold text-textsecondary block uppercase">DATOS CONSUMIDOS</span>
                    <span className="font-display text-3xl font-bold text-textprimary">
                      2,0 <span className="text-sm font-normal text-textsecondary">/ 5,0 MB</span>
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-[10px] font-semibold text-textsecondary block uppercase">MARGEN RESTANTE</span>
                    <span className="font-display text-3xl font-bold text-primaryviolet">3,0 MB</span>
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-textsecondary uppercase tracking-wider font-semibold">PROPULSOR DE DATOS</span>
                  <span className="text-primaryviolet font-bold">2,0 MB LIQUIDADOS</span>
                </div>
                <div className="h-2.5 w-full bg-gray-200/80 rounded-full overflow-hidden p-0.5">
                  <div className="h-full rounded-full bg-gradient-to-r from-primaryviolet to-tealbrand w-[40%] transition-all duration-700" />
                </div>
              </div>
            </div>

            {/* Right: balance + AI copilot */}
            <div className="lg:col-span-5 flex flex-col gap-5">
              {/* Balance card */}
              <div className="p-6 rounded-2xl bg-white border border-cardborder shadow-sm flex flex-col gap-1.5">
                <span className="font-mono text-xs font-bold text-textsecondary uppercase tracking-wider">SALDO DISPONIBLE EN WALLET</span>
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-5xl font-bold text-textprimary tracking-tight">3,00</span>
                  <span className="font-mono text-lg font-bold text-primaryviolet">USDC</span>
                </div>
                <span className="text-xs text-textsecondary mt-1">Custodia descentralizada en Stellar Testnet.</span>
              </div>

              {/* AI copilot */}
              <div className="p-6 rounded-2xl bg-primaryviolet-light border border-primaryviolet/20 flex flex-col gap-2.5 relative">
                <div className="flex items-center gap-2 text-primaryviolet font-mono text-xs font-bold tracking-wider uppercase">
                  <span className="material-symbols-outlined text-base">smart_toy</span>
                  COPILOTO AI // REPORTE DE VUELO
                </div>
                <p className="text-sm text-textprimary italic leading-relaxed">
                  "Tu misión está dentro del presupuesto. Disponés de aproximadamente 3 MB adicionales en esta zona. La conexión se pausará automáticamente si alcanzás el límite para proteger tu saldo."
                </p>
              </div>
            </div>

          </div>
        </div>
      </div>
    </section>
  )
}
