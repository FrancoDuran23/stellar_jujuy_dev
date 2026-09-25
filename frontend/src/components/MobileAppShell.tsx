import React from 'react'
import { useNavigate } from 'react-router-dom'
import logoSrc from '../assets/logo.png'
import MobileBottomNav from './MobileBottomNav'
import SystemBadge from './SystemBadge'

interface MobileAppShellProps {
  title?: string
  showBack?: boolean
  showBottomNav?: boolean
  onActivityClick?: () => void
  children: React.ReactNode
}

export default function MobileAppShell({
  title,
  showBack = false,
  showBottomNav = true,
  onActivityClick,
  children,
}: MobileAppShellProps) {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-bglight relative overflow-x-hidden flex flex-col">
      {/* Background grid */}
      <div className="fixed inset-0 fintech-grid opacity-50 pointer-events-none" />

      {/* Glow ambient lights */}
      <div className="fixed top-0 -left-32 w-72 h-72 bg-primaryviolet/8 rounded-full blur-[100px] pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-64 h-64 bg-tealbrand/8 rounded-full blur-[80px] pointer-events-none" />

      {/* App Header (Mobile optimized & Desktop consistent) */}
      <header className="sticky top-0 z-30 w-full bg-white/90 backdrop-blur-md border-b border-cardborder pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            {showBack && (
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="w-9 h-9 rounded-full bg-bglight border border-cardborder flex items-center justify-center text-textsecondary hover:text-textprimary transition-all shrink-0"
                aria-label="Volver atrás"
              >
                <span className="material-symbols-outlined text-lg">arrow_back</span>
              </button>
            )}
            <a href="/" className="flex items-center gap-2 group shrink-0">
              <img src={logoSrc} alt="ASTROAM" className="h-6 sm:h-7 object-contain group-hover:scale-105 transition-transform" />
            </a>
            {title && (
              <span className="hidden sm:inline font-mono text-xs font-semibold text-textsecondary border-l border-cardborder pl-3">
                {title}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <SystemBadge />
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className={`flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-6 ${showBottomNav ? 'pb-24 sm:pb-8' : 'pb-6'}`}>
        {children}
      </main>

      {/* Mobile Bottom Navigation */}
      {showBottomNav && <MobileBottomNav onActivityClick={onActivityClick} />}
    </div>
  )
}
