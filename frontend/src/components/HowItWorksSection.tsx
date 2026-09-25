export default function HowItWorksSection() {
  return (
    <section id="como-funciona" className="relative py-24 px-6 md:px-12 bg-bglight overflow-hidden">
      <div className="max-w-7xl mx-auto flex flex-col gap-16">

        {/* Header */}
        <div className="flex flex-col items-center text-center gap-3 max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 font-mono text-xs font-bold text-primaryviolet tracking-widest uppercase">
            [ SECUENCIA DE LANZAMIENTO // 4 CHECKPOINTS ]
          </div>
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-textprimary">
            CÓMO FUNCIONA
          </h2>
          <p className="text-base sm:text-lg text-textsecondary">
            Un recorrido continuo de 4 niveles que activa tu conectividad en segundos sobre la infraestructura descentralizada de Stellar.
          </p>
        </div>

        {/* 4 station cards */}
        <div className="relative grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">

          {/* Station 1 */}
          <div className="flex flex-col gap-5 p-6 rounded-2xl bg-white border border-cardborder hover:border-primaryviolet/40 hover:shadow-md transition-all group">
            <div className="h-40 w-full rounded-xl bg-[#FAF8FE] flex items-center justify-center relative overflow-hidden border border-primaryviolet/10">
              <svg className="w-28 h-28" fill="none" viewBox="0 0 120 120">
                <circle cx="60" cy="60" opacity="0.4" r="45" stroke="#6941FF" strokeDasharray="3 3" strokeWidth="1.2" />
                <circle cx="60" cy="60" fill="#FFFFFF" r="26" stroke="#6941FF" strokeWidth="1.5" />
                <line opacity="0.3" stroke="#6941FF" strokeDasharray="2 2" strokeWidth="0.8" x1="60" x2="60" y1="15" y2="105" />
                <line opacity="0.3" stroke="#6941FF" strokeDasharray="2 2" strokeWidth="0.8" x1="15" x2="105" y1="60" y2="60" />
                <circle className="animate-ping" cx="76" cy="46" fill="#008C99" r="4" />
                <circle cx="76" cy="46" fill="#008C99" r="3" />
              </svg>
              <span className="absolute bottom-2 left-3 font-mono text-[9px] font-semibold text-primaryviolet tracking-widest">[ COORD: -23.55 // -46.63 ]</span>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-primaryviolet">NIVEL 01</span>
                <span className="w-2 h-2 rounded-full bg-primaryviolet" />
              </div>
              <h3 className="font-display text-lg font-bold text-textprimary">ELEGÍ TU DESTINO</h3>
              <p className="text-xs text-textsecondary leading-relaxed">
                Seleccioná el país al que viajás y conocé la tarifa exacta por megabyte. Sin tarifas ocultas ni contratos.
              </p>
            </div>
          </div>

          {/* Station 2 */}
          <div className="flex flex-col gap-5 p-6 rounded-2xl bg-white border border-cardborder hover:border-tealbrand/40 hover:shadow-md transition-all group">
            <div className="h-40 w-full rounded-xl bg-[#FAF8FE] flex items-center justify-center relative overflow-hidden border border-primaryviolet/10">
              <svg className="w-28 h-28" fill="none" viewBox="0 0 120 120">
                <rect fill="#FFFFFF" height="66" rx="16" stroke="#008C99" strokeWidth="1.8" width="34" x="43" y="27" />
                <rect fill="#008C99" fillOpacity="0.2" height="36" rx="10" width="26" x="47" y="53" />
                <line stroke="#008C99" strokeLinecap="round" strokeWidth="1.5" x1="49" x2="71" y1="49" y2="49" />
                <circle cx="60" cy="71" fill="#FFFFFF" r="7" stroke="#008C99" strokeWidth="1.2" />
                <text fill="#008C99" fontFamily="'Space Mono', monospace" fontSize="9" fontWeight="bold" textAnchor="middle" x="60" y="75">$</text>
              </svg>
              <span className="absolute bottom-2 left-3 font-mono text-[9px] font-semibold text-tealbrand tracking-widest">[ SALDO SEGURO: USDC ]</span>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-tealbrand">NIVEL 02</span>
                <span className="w-2 h-2 rounded-full bg-tealbrand" />
              </div>
              <h3 className="font-display text-lg font-bold text-textprimary">CARGÁ COMBUSTIBLE</h3>
              <p className="text-xs text-textsecondary leading-relaxed">
                Depositá saldo en USDC. Tu dinero permanece seguro bajo tu custodia en la red Stellar y nunca vence.
              </p>
            </div>
          </div>

          {/* Station 3 */}
          <div className="flex flex-col gap-5 p-6 rounded-2xl bg-white border border-cardborder hover:border-online/40 hover:shadow-md transition-all group">
            <div className="h-40 w-full rounded-xl bg-[#FAF8FE] flex items-center justify-center relative overflow-hidden border border-primaryviolet/10">
              <svg className="w-28 h-28" fill="none" viewBox="0 0 120 120">
                <rect fill="#FFFFFF" height="22" rx="3" stroke="#6941FF" strokeWidth="1.5" width="16" x="52" y="38" />
                <rect fill="#EEE9FF" height="12" stroke="#6941FF" strokeWidth="1.2" width="22" x="24" y="43" />
                <rect fill="#EEE9FF" height="12" stroke="#6941FF" strokeWidth="1.2" width="22" x="74" y="43" />
                <path d="M 44 74 A 18 18 0 0 0 76 74" stroke="#31C48D" strokeDasharray="3 3" strokeWidth="1.5" />
                <path d="M 36 84 A 28 28 0 0 0 84 84" opacity="0.7" stroke="#31C48D" strokeDasharray="3 3" strokeWidth="1.5" />
                <circle cx="60" cy="96" fill="#31C48D" r="3.5" />
              </svg>
              <span className="absolute bottom-2 left-3 font-mono text-[9px] font-semibold text-online tracking-widest">[ TELNYX eSIM LINK ]</span>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-online">NIVEL 03</span>
                <span className="w-2 h-2 rounded-full bg-online" />
              </div>
              <h3 className="font-display text-lg font-bold text-textprimary">ACTIVÁ TU eSIM</h3>
              <p className="text-xs text-textsecondary leading-relaxed">
                Escaneá el código QR en segundos. Tu enlace satelital queda listo para encenderse antes de aterrizar.
              </p>
            </div>
          </div>

          {/* Station 4 */}
          <div className="flex flex-col gap-5 p-6 rounded-2xl bg-white border border-cardborder hover:border-primaryviolet/40 hover:shadow-md transition-all group">
            <div className="h-40 w-full rounded-xl bg-[#FAF8FE] flex items-center justify-center relative overflow-hidden border border-primaryviolet/10">
              <svg className="w-28 h-28" fill="none" viewBox="0 0 120 120">
                <ellipse cx="60" cy="60" rx="42" ry="18" stroke="#6941FF" strokeWidth="1.2" transform="rotate(-15 60 60)" />
                <ellipse cx="60" cy="60" rx="42" ry="18" stroke="#008C99" strokeDasharray="3 3" strokeWidth="1.2" transform="rotate(35 60 60)" />
                <circle cx="60" cy="60" fill="#FFFFFF" r="10" stroke="#6941FF" strokeWidth="1.5" />
                <circle cx="60" cy="60" fill="#6941FF" r="4" />
                <circle className="animate-pulse" cx="90" cy="52" fill="#FDDA24" r="3.5" />
                <circle cx="32" cy="72" fill="#FDDA24" r="3" />
                <circle cx="50" cy="40" fill="#008C99" r="3" />
              </svg>
              <span className="absolute bottom-2 left-3 font-mono text-[9px] font-semibold text-primaryviolet tracking-widest">[ MICROPAGOS EN VIVO ]</span>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-primaryviolet">NIVEL 04</span>
                <span className="w-2 h-2 rounded-full bg-primaryviolet" />
              </div>
              <h3 className="font-display text-lg font-bold text-textprimary">PAGÁ POR CONSUMO</h3>
              <p className="text-xs text-textsecondary leading-relaxed">
                Navegá sin fricción. Cada bloque de megabytes se liquida automáticamente. Lo que no usás, no lo pagás.
              </p>
            </div>
          </div>

        </div>
      </div>
    </section>
  )
}
