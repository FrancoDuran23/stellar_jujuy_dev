import { useLocation, useNavigate } from 'react-router-dom'

interface MobileBottomNavProps {
  onActivityClick?: () => void
}

export default function MobileBottomNav({ onActivityClick }: MobileBottomNavProps) {
  const navigate = useNavigate()
  const location = useLocation()

  const currentPath = location.pathname

  const isMissionActive = currentPath === '/mission/active'
  const isEsim = currentPath === '/mission/esim'

  function handleNav(destination: 'active' | 'esim' | 'activity') {
    if (destination === 'active') {
      if (!isMissionActive) navigate('/mission/active')
      else window.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (destination === 'esim') {
      if (!isEsim) navigate('/mission/esim')
      else window.scrollTo({ top: 0, behavior: 'smooth' })
    } else if (destination === 'activity') {
      if (!isMissionActive) {
        navigate('/mission/active#activity-feed')
      } else {
        if (onActivityClick) {
          onActivityClick()
        } else {
          const el = document.getElementById('activity-feed')
          if (el) {
            el.scrollIntoView({ behavior: 'smooth' })
          } else {
            window.scrollTo({ top: 800, behavior: 'smooth' })
          }
        }
      }
    }
  }

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-lg border-t border-cardborder shadow-[0_-4px_20px_rgba(15,23,42,0.06)] pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 px-4">
      <div className="flex items-center justify-around max-w-md mx-auto">
        {/* Tab 1: Misión */}
        <button
          type="button"
          onClick={() => handleNav('active')}
          className={`flex flex-col items-center justify-center min-w-[64px] min-h-[48px] py-1 px-3 rounded-2xl transition-all ${
            isMissionActive
              ? 'text-primaryviolet bg-primaryviolet/10 font-bold'
              : 'text-textsecondary hover:text-textprimary'
          }`}
          aria-label="Ir a Misión Active"
        >
          <span className="material-symbols-outlined text-xl mb-0.5">rocket_launch</span>
          <span className="font-sans text-[11px] uppercase tracking-wider">MISIÓN</span>
        </button>

        {/* Tab 2: eSIM */}
        <button
          type="button"
          onClick={() => handleNav('esim')}
          className={`flex flex-col items-center justify-center min-w-[64px] min-h-[48px] py-1 px-3 rounded-2xl transition-all ${
            isEsim
              ? 'text-primaryviolet bg-primaryviolet/10 font-bold'
              : 'text-textsecondary hover:text-textprimary'
          }`}
          aria-label="Ir a eSIM"
        >
          <span className="material-symbols-outlined text-xl mb-0.5">sim_card</span>
          <span className="font-sans text-[11px] uppercase tracking-wider">eSIM</span>
        </button>

        {/* Tab 3: Actividad */}
        <button
          type="button"
          onClick={() => handleNav('activity')}
          className="flex flex-col items-center justify-center min-w-[64px] min-h-[48px] py-1 px-3 rounded-2xl text-textsecondary hover:text-textprimary transition-all"
          aria-label="Ver Historial de Actividad"
        >
          <span className="material-symbols-outlined text-xl mb-0.5">history</span>
          <span className="font-sans text-[11px] uppercase tracking-wider">ACTIVIDAD</span>
        </button>
      </div>
    </nav>
  )
}
