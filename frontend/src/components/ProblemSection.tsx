const obstacles = [
  {
    icon: 'event_busy',
    iconClass: 'group-hover:rotate-12',
    number: 'OBSTÁCULO 01',
    title: 'PAQUETES DEMASIADO LARGOS',
    desc: 'Te cobran 7, 15 o 30 días obligatorios cuando tu viaje dura un fin de semana o una escala de horas.',
    penalty: 'Pérdida por inmovilización',
  },
  {
    icon: 'cloud_off',
    iconClass: 'group-hover:-rotate-12',
    number: 'OBSTÁCULO 02',
    title: 'DATOS QUE NO UTILIZÁS',
    desc: 'Comprás 10 GB, consumís 2 GB y el remanente se esfuma al cumplirse el plazo. Tu dinero nunca regresa.',
    penalty: 'Saldo confiscado',
  },
  {
    icon: 'receipt_long',
    iconClass: 'group-hover:scale-110',
    number: 'OBSTÁCULO 03',
    title: 'GASTOS SIN CONTROL',
    desc: 'Consumos en segundo plano generan cargos sorpresa abusivos que recién descubrís en el resumen de fin de mes.',
    penalty: 'Facturas sorpresa',
  },
]

export default function ProblemSection() {
  return (
    <section className="relative py-24 px-6 md:px-12 bg-white border-y border-cardborder overflow-hidden">
      <div className="max-w-7xl mx-auto flex flex-col gap-14">

        {/* Section title */}
        <div className="max-w-3xl flex flex-col gap-3">
          <div className="inline-flex items-center gap-2 font-mono text-xs font-bold text-alerta tracking-widest uppercase">
            <span className="material-symbols-outlined text-sm">warning</span>
            ZONA DE ANOMALÍAS DETECTADA
          </div>
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-textprimary leading-tight">
            EL ROAMING TRADICIONAL CONSUME MÁS DE LO QUE NECESITÁS.
          </h2>
          <p className="text-base sm:text-lg text-textsecondary leading-relaxed">
            Las operadoras antiguas te obligan a comprar paquetes cerrados y rígidos. La nave ASTROAM sortea los asteroides del modelo obsoleto con vuelo ágil y micropagos autónomos.
          </p>
        </div>

        {/* 3 obstacle cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative z-10">
          {obstacles.map((o) => (
            <div
              key={o.number}
              className="flex flex-col justify-between p-8 rounded-2xl bg-bglight border border-cardborder hover:border-primaryviolet/50 hover:shadow-md transition-all group"
            >
              <div className="flex flex-col gap-4">
                <div className="w-14 h-14 rounded-2xl bg-white border border-cardborder flex items-center justify-center text-primaryviolet shadow-sm">
                  <span className={`material-symbols-outlined text-2xl transition-transform ${o.iconClass}`}>{o.icon}</span>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-xs font-bold text-textsecondary tracking-wider">{o.number}</span>
                  <h3 className="font-display text-xl font-bold text-textprimary group-hover:text-primaryviolet transition-colors">
                    {o.title}
                  </h3>
                  <p className="text-sm text-textsecondary leading-relaxed">{o.desc}</p>
                </div>
              </div>
              <div className="pt-6 mt-6 border-t border-cardborder font-mono text-xs text-alerta font-medium flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">close</span>
                {o.penalty}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
