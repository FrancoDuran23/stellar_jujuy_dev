import logoFooterSrc from '../assets/logo-footer.png'

export default function Footer() {
  return (
    <footer className="relative z-10 border-t border-cardborder bg-warmneutral py-10 px-6 md:px-12">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">

        {/* Logo + network badge */}
        <div className="flex items-center gap-3.5">
          <img src={logoFooterSrc} alt="ASTROAM" className="h-6 object-contain" />
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white border border-cardborder text-[10px] font-mono text-online font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-online" />
            RED ACTIVA
          </span>
        </div>

        {/* Copyright */}
        <p className="text-xs text-textsecondary text-center md:text-left">
          Conectividad soberana sin fronteras. Diseñado sobre Stellar Soroban y red Telnyx.
        </p>

        {/* Nav links */}
        <div className="flex items-center gap-6 font-mono text-xs text-textsecondary">
          <a href="#como-funciona" className="hover:text-primaryviolet transition-colors">CÓMO FUNCIONA</a>
          <a href="#tecnologia" className="hover:text-primaryviolet transition-colors">TECNOLOGÍA</a>
          <a href="#cabina" className="hover:text-primaryviolet transition-colors">CABINA</a>
        </div>

      </div>
    </footer>
  )
}
