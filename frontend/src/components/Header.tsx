import { Link } from 'react-router-dom'
import logoSrc from '../assets/logo.png'
import SystemBadge from './SystemBadge'

export default function Header() {
  return (
    <header className="fixed top-0 left-0 w-full z-50 bg-white/90 backdrop-blur-md border-b border-gray-200/80 transition-all">
      <div className="max-w-7xl mx-auto h-20 px-6 md:px-12 flex items-center justify-between">

        {/* Logo */}
        <a href="/" className="flex items-center gap-3.5 group">
          <img
            src={logoSrc}
            alt="ASTROAM"
            className="h-8 sm:h-9 object-contain transition-transform duration-200 group-hover:scale-105"
          />
          <SystemBadge />
        </a>

        {/* Nav links */}
        <nav className="hidden md:flex items-center gap-8">
          <a href="#como-funciona" className="text-sm font-medium text-textsecondary hover:text-primaryviolet transition-colors">
            Cómo funciona
          </a>
          <a href="#tecnologia" className="text-sm font-medium text-textsecondary hover:text-primaryviolet transition-colors">
            Tecnología
          </a>
          <a href="#cabina" className="text-sm font-medium text-textsecondary hover:text-primaryviolet transition-colors">
            Demo en vivo
          </a>
        </nav>

        {/* CTA button → /mission/new */}
        <div className="flex items-center">
          <Link
            to="/mission/new"
            className="px-6 py-2.5 rounded-full bg-primaryviolet text-white font-sans font-semibold text-xs tracking-wider uppercase hover:bg-primaryviolet-hover shadow-[0_4px_14px_rgba(105,65,255,0.35)] hover:shadow-[0_6px_20px_rgba(105,65,255,0.45)] hover:-translate-y-0.5 transition-all duration-200 flex items-center gap-2"
          >
            <span>INICIAR MISIÓN</span>
            <span className="material-symbols-outlined text-sm">rocket_launch</span>
          </Link>
        </div>
      </div>
    </header>
  )
}
