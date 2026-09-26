import { Link } from 'react-router-dom'
import shipCtaSrc from '../assets/ship-cta.png'

export default function FinalCTA() {
  return (
    <section
      id="portal"
      className="relative py-28 px-6 md:px-12 bg-white border-t border-cardborder overflow-hidden group-launch"
    >
      {/* Orbital glow rings */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none flex items-center justify-center">
        <div className="absolute inset-0 rounded-full border border-primaryviolet/20 animate-portal launch-portal transition-all duration-700" />
        <div
          className="w-[450px] h-[450px] rounded-full border border-tealbrand/20 animate-spin"
          style={{ animationDuration: '35s' }}
        />
        <div className="w-[320px] h-[320px] rounded-full bg-gradient-to-tr from-primaryviolet/10 via-tealbrand/5 to-transparent blur-2xl" />
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto flex flex-col items-center text-center gap-6 relative z-10">

        {/* Floating ship */}
        <div className="w-24 h-24 relative animate-float-ship launch-thrust transition-all duration-500">
          <img
            src={shipCtaSrc}
            alt="Nave ASTROAM"
            className="w-full h-full object-contain drop-shadow-[0_12px_24px_rgba(105,65,255,0.35)]"
          />
        </div>

        {/* Active portal badge */}
        <div className="inline-flex items-center gap-2 px-4 py-1 rounded-full bg-primaryviolet-light border border-primaryviolet/30 font-mono text-xs font-bold text-primaryviolet tracking-widest uppercase">
          <span className="w-2 h-2 rounded-full bg-primaryviolet animate-pulse" />
          PORTAL HIPERLUMÍNICO ACTIVO
        </div>

        {/* Headline */}
        <h2 className="font-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-textprimary leading-tight">
          TU PRÓXIMA MISIÓN<br />
          <span className="text-primaryviolet">ESTÁ LISTA.</span>
        </h2>

        {/* Subtitle */}
        <p className="text-base sm:text-lg text-textsecondary max-w-xl font-normal leading-relaxed">
          Elegí tu destino, cargá saldo y mantenete conectado desde el momento en que aterrizás. La era del roaming obsoleto quedó en el pasado.
        </p>

        {/* CTA button → /mission/new */}
        <div className="pt-2">
          <Link
            to="/mission/new"
            className="px-10 py-4 rounded-full bg-primaryviolet text-white font-sans text-base font-bold tracking-wider uppercase shadow-[0_6px_20px_rgba(105,65,255,0.4)] hover:bg-primaryviolet-hover hover:scale-105 hover:shadow-[0_10px_28px_rgba(105,65,255,0.5)] active:scale-95 transition-all duration-200 flex items-center gap-3"
          >
            <span className="material-symbols-outlined text-xl">rocket_launch</span>
            <span>INICIAR MISIÓN AHORA</span>
          </Link>
        </div>

        {/* Trust badges */}
        <div className="flex flex-wrap items-center justify-center gap-6 font-mono text-xs text-textsecondary uppercase tracking-widest pt-4">
          <span>SIN CONTRATOS</span>
          <span>·</span>
          <span>SIN CARGOS SORPRESA</span>
          <span>·</span>
          <span>100% STELLAR</span>
        </div>
      </div>
    </section>
  )
}
