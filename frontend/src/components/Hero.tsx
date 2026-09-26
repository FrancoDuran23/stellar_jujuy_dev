import { Link } from 'react-router-dom'
import shipSrc from '../assets/ship.png'

export default function Hero() {
  return (
    <section className="relative min-h-[90vh] flex items-center px-6 md:px-12 py-12 md:py-20 overflow-hidden">
      {/* Ambient glows */}
      <div className="absolute top-1/4 -left-20 w-96 h-96 bg-primaryviolet/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-1/3 right-10 w-[450px] h-[450px] bg-tealbrand/10 rounded-full blur-[140px] pointer-events-none" />

      <div className="max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-10 items-center">

        {/* Left column */}
        <div className="lg:col-span-6 flex flex-col items-start gap-6">
          {/* Tag pill */}
          <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-white border border-cardborder shadow-sm">
            <span className="w-2 h-2 rounded-full bg-tealbrand animate-pulse" />
            <span className="font-mono text-xs font-semibold text-tealbrand tracking-wider uppercase">
              ROAMING INTELIGENTE · POWERED BY STELLAR
            </span>
          </div>

          {/* Hero headline */}
          <h1 className="font-display text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight text-textprimary leading-tight">
            TU CONEXIÓN.<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primaryviolet via-[#7C58FF] to-tealbrand">
              TU MISIÓN.
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-lg md:text-xl text-textsecondary max-w-xl font-normal leading-relaxed">
            Viajá conectado y pagá únicamente por los datos que realmente consumís. Sin contratos rígidos ni paquetes inflados. Tu conexión fluye con la velocidad y economía de la red Stellar.
          </p>

          {/* CTA buttons */}
          <div className="flex flex-wrap items-center gap-4 pt-1 group-launch">
            <Link
              to="/mission/new"
              className="px-8 py-3.5 rounded-full bg-primaryviolet text-white font-sans font-semibold text-sm uppercase tracking-wider shadow-[0_4px_16px_rgba(105,65,255,0.35)] hover:bg-primaryviolet-hover hover:shadow-[0_8px_24px_rgba(105,65,255,0.5)] transition-all transform hover:-translate-y-0.5 flex items-center gap-2.5"
            >
              <span>INICIAR MISIÓN</span>
              <span className="material-symbols-outlined text-base">rocket_launch</span>
            </Link>
            <a
              href="#como-funciona"
              className="px-7 py-3.5 rounded-full border border-cardborder bg-white text-textprimary font-sans font-semibold text-sm uppercase tracking-wider hover:bg-primaryviolet-light hover:border-primaryviolet/40 hover:text-primaryviolet shadow-sm hover:shadow transition-all duration-200"
            >
              VER CÓMO FUNCIONA
            </a>
          </div>

          {/* 3 metric cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-6 w-full mt-2">
            <div className="flex flex-col gap-1 p-4 rounded-2xl bg-white border border-cardborder shadow-sm">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primaryviolet" />
                <span className="font-mono text-[11px] font-bold text-primaryviolet tracking-wider uppercase">01 // TARIFA</span>
              </div>
              <span className="font-display text-base font-bold text-textprimary mt-1">Pago por consumo</span>
              <span className="text-xs text-textsecondary">Fraccionado por cada MB</span>
            </div>
            <div className="flex flex-col gap-1 p-4 rounded-2xl bg-white border border-cardborder shadow-sm">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-tealbrand" />
                <span className="font-mono text-[11px] font-bold text-tealbrand tracking-wider uppercase">02 // CONTROL</span>
              </div>
              <span className="font-display text-base font-bold text-textprimary mt-1">Límite automático</span>
              <span className="text-xs text-textsecondary">Sin sorpresas en la factura</span>
            </div>
            <div className="flex flex-col gap-1 p-4 rounded-2xl bg-white border border-cardborder shadow-sm">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-stellar" />
                <span className="font-mono text-[11px] font-bold text-textprimary tracking-wider uppercase">03 // CUSTODIA</span>
              </div>
              <span className="font-display text-base font-bold text-textprimary mt-1">Saldo reutilizable</span>
              <span className="text-xs text-textsecondary">Nunca vence en tu wallet</span>
            </div>
          </div>
        </div>

        {/* Right column: floating fintech card */}
        <div className="lg:col-span-6 relative flex items-center justify-center">
          <div className="w-full max-w-xl bg-white rounded-3xl border border-cardborder shadow-[0_16px_40px_rgba(25,24,29,0.08)] p-6 sm:p-8 relative overflow-hidden">

            {/* Card header */}
            <div className="flex items-center justify-between pb-5 border-b border-gray-100">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-online animate-pulse" />
                <span className="font-mono text-xs font-bold text-textprimary uppercase tracking-wider">CONEXIÓN LISTA</span>
              </div>
              <span className="px-3 py-1 rounded-full bg-primaryviolet-light text-primaryviolet font-mono text-[11px] font-semibold tracking-wide">
                Liquidación en Stellar
              </span>
            </div>

            {/* Orbital scene */}
            <div className="relative min-h-[300px] w-full rounded-2xl bg-[#FAF8FE] border border-primaryviolet/10 my-5 overflow-hidden flex items-center justify-center">
              <svg className="absolute inset-0 w-full h-full pointer-events-none" fill="none" viewBox="0 0 500 300">
                {/* Asteroid polygons */}
                <polygon className="animate-drift-a" fill="#F4F0FF" opacity="0.8" points="60,40 85,25 105,50 90,75 60,65" stroke="#C9BEFF" strokeWidth="1.2" />
                <polygon className="animate-drift-b" fill="#EBF9FB" opacity="0.9" points="410,220 440,205 455,235 435,265 400,250" stroke="#89EFFD" strokeWidth="1.2" />
                {/* Orbital path Argentina → Brasil */}
                <path d="M 80 230 Q 230 70 420 80" opacity="0.65" stroke="#6941FF" strokeDasharray="6 5" strokeLinecap="round" strokeWidth="2.5" />
                {/* Animated pulse beam */}
                <path
                  d="M 80 230 Q 230 70 420 80"
                  stroke="#FDDA24"
                  strokeDasharray="25 180"
                  strokeLinecap="round"
                  strokeWidth="3"
                  className="animate-pulse-beam"
                />
                {/* Checkpoints */}
                <circle cx="80" cy="230" fill="#6941FF" r="6" />
                <circle cx="80" cy="230" opacity="0.3" r="14" stroke="#6941FF" strokeWidth="1.5" />
                <circle cx="215" cy="135" fill="#FDDA24" r="5" />
                <circle className="animate-spin" cx="215" cy="135" r="12" stroke="#FDDA24" strokeDasharray="3 3" strokeWidth="1.5" />
                <circle cx="330" cy="92" fill="#008C99" r="5" />
                {/* Planet Brasil */}
                <g transform="translate(420, 80)">
                  <ellipse cx="0" cy="0" rx="42" ry="14" stroke="#008C99" strokeDasharray="4 3" strokeWidth="1.2" transform="rotate(-18)" />
                  <circle cx="0" cy="0" fill="#FFFFFF" r="20" stroke="#008C99" strokeWidth="2" />
                  <circle cx="-3" cy="-4" fill="#E5F7F8" r="12" />
                  <text fill="#008C99" fontFamily="'Space Mono', monospace" fontSize="9" fontWeight="bold" letterSpacing="1" textAnchor="middle" x="0" y="32">BRASIL [GIG]</text>
                </g>
                {/* Base Argentina */}
                <g transform="translate(80, 230)">
                  <text fill="#6941FF" fontFamily="'Space Mono', monospace" fontSize="9" fontWeight="bold" letterSpacing="1" textAnchor="middle" x="0" y="24">ARGENTINA [EZE]</text>
                </g>
              </svg>

              {/* Floating ship */}
              <div className="absolute left-[44%] top-[38%] -translate-x-1/2 -translate-y-1/2 z-20 flex flex-col items-center">
                <div className="w-24 h-24 relative animate-float-ship launch-thrust transition-all duration-300 cursor-pointer">
                  <img
                    src={shipSrc}
                    alt="Nave ASTROAM"
                    className="w-full h-full object-contain drop-shadow-[0_8px_18px_rgba(105,65,255,0.4)]"
                  />
                  {/* +1 MB badge */}
                  <div className="absolute -top-2 -right-2 px-2 py-0.5 rounded-full bg-stellar text-textprimary font-mono font-bold text-[10px] tracking-wider shadow-md animate-bounce border border-yellow-400/50">
                    +1 MB
                  </div>
                </div>
              </div>
            </div>

            {/* HUD telemetry */}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div className="p-3.5 rounded-2xl bg-bglight border border-cardborder">
                <div className="flex items-center gap-1.5 text-textsecondary font-mono text-[11px] uppercase font-semibold">
                  <span className="material-symbols-outlined text-sm text-primaryviolet">account_balance_wallet</span>
                  COMBUSTIBLE
                </div>
                <div className="font-display text-2xl font-bold text-textprimary mt-1">
                  5,00 <span className="text-xs font-mono font-normal text-textsecondary">USDC</span>
                </div>
              </div>
              <div className="p-3.5 rounded-2xl bg-bglight border border-cardborder">
                <div className="flex items-center gap-1.5 text-textsecondary font-mono text-[11px] uppercase font-semibold">
                  <span className="material-symbols-outlined text-sm text-tealbrand">wifi_tethering</span>
                  CONSUMO
                </div>
                <div className="font-display text-2xl font-bold text-textprimary mt-1">
                  0,0 <span className="text-xs font-mono font-normal text-textsecondary">/ 5 MB</span>
                </div>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs">
              <span className="font-mono text-textsecondary uppercase tracking-wider">DESTINO FIJADO</span>
              <span className="font-sans font-bold text-primaryviolet">BRASIL ORBITAL (4G/5G)</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
