import shipSmSrc from '../assets/ship-sm.png'

const steps = [
  {
    icon: 'account_circle',
    color: 'text-primaryviolet',
    step: 'PASO 01',
    title: 'USUARIO',
    desc: 'Define presupuesto y navega',
    img: null,
  },
  {
    icon: null,
    color: '',
    step: 'PASO 02',
    title: 'NAVE ASTROAM',
    desc: 'Firma vouchers en segundo plano',
    img: shipSmSrc,
  },
  {
    icon: 'toll',
    color: 'text-yellow-500',
    step: 'PASO 03',
    title: 'CHECKPOINT',
    desc: 'Valida consumo byte a byte',
    img: null,
  },
  {
    icon: 'hub',
    color: 'text-tealbrand',
    step: 'PASO 04',
    title: 'RED STELLAR',
    desc: 'Liquidación en 5 segundos',
    img: null,
  },
  {
    icon: 'cell_tower',
    color: 'text-online',
    step: 'PASO 05',
    title: 'PROVEEDOR',
    desc: 'Mantiene enlace 4G/5G seguro',
    img: null,
  },
]

const stepColors: Record<string, string> = {
  'PASO 01': 'text-primaryviolet',
  'PASO 02': 'text-primaryviolet',
  'PASO 03': 'text-textprimary',
  'PASO 04': 'text-tealbrand',
  'PASO 05': 'text-online',
}

const pillars = [
  { code: '01 // USDC', color: 'text-primaryviolet', title: 'Moneda Estable', desc: 'Sin fluctuaciones cambiarias ni comisiones bancarias imprevistas durante tu viaje.' },
  { code: '02 // MICROPAGOS', color: 'text-tealbrand', title: 'Fracciones Mínimas', desc: 'Pagá exactamente por los megabytes que descargás y ni un solo centavo de más.' },
  { code: '03 // FINALIDAD', color: 'text-primaryviolet', title: 'Liquidación Rápida', desc: 'Consenso en 5 segundos con el costo de transacción más bajo del ecosistema.' },
  { code: '04 // TRANSPARENCIA', color: 'text-online', title: 'Registro Verificable', desc: 'Auditabilidad total en blockchain para garantizar soberanía sobre tus fondos.' },
]

export default function TechnologySection() {
  return (
    <section id="tecnologia" className="relative py-24 px-6 md:px-12 bg-bglight border-t border-cardborder overflow-hidden">
      <div className="max-w-7xl mx-auto flex flex-col gap-16">

        {/* Header */}
        <div className="flex flex-col items-center text-center gap-3 max-w-3xl mx-auto">
          <span className="font-mono text-xs font-bold text-tealbrand uppercase tracking-widest">
            [ ARQUITECTURA DE LIQUIDACIÓN DETERMINÍSTICA ]
          </span>
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-textprimary">
            MICROPAGOS QUE IMPULSAN CADA TRAMO
          </h2>
          <p className="text-base sm:text-lg text-textsecondary">
            Un circuito dinámico y auditable donde cada megabyte consumido genera un micropago directo sin fricción ni intermediarios.
          </p>
        </div>

        {/* 5-step circuit */}
        <div className="w-full p-8 md:p-10 rounded-3xl bg-white border border-cardborder shadow-[0_8px_30px_rgba(25,24,29,0.04)] relative overflow-hidden">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5 relative z-10 items-center">
            {steps.map((s) => (
              <div
                key={s.step}
                className="flex flex-col items-center text-center p-5 rounded-2xl bg-bglight border border-cardborder hover:border-primaryviolet hover:shadow-sm transition-all"
              >
                <div className="w-12 h-12 rounded-full bg-white border border-cardborder flex items-center justify-center mb-3 shadow-xs">
                  {s.img ? (
                    <img src={s.img} alt={s.title} className="w-full h-full object-contain p-1.5" />
                  ) : (
                    <span className={`material-symbols-outlined text-2xl ${s.color}`}>{s.icon}</span>
                  )}
                </div>
                <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${stepColors[s.step]}`}>{s.step}</span>
                <span className="font-display text-base font-bold text-textprimary mt-1">{s.title}</span>
                <span className="text-xs text-textsecondary mt-1">{s.desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 4 pillar cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {pillars.map((p) => (
            <div key={p.code} className="p-6 rounded-2xl bg-white border border-cardborder shadow-xs flex flex-col gap-2">
              <span className={`font-mono text-xs font-bold tracking-wider ${p.color}`}>{p.code}</span>
              <h4 className="font-display text-lg font-bold text-textprimary">{p.title}</h4>
              <p className="text-xs text-textsecondary leading-relaxed">{p.desc}</p>
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}
