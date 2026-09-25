import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MobileAppShell from '../components/MobileAppShell'
import { useMission } from '../hooks/useMission'

export default function EsimSetupPage() {
  const navigate = useNavigate()
  const { mission } = useMission()
  const [copiedLpa, setCopiedLpa] = useState(false)
  const [copiedIccid, setCopiedIccid] = useState(false)
  const [activeTab, setActiveTab] = useState<'iphone' | 'android'>('iphone')

  if (!mission) {
    return (
      <div className="min-h-screen bg-bglight flex flex-col items-center justify-center p-6 text-center">
        <div className="bg-white p-8 rounded-3xl border border-cardborder shadow-sm max-w-md">
          <span className="material-symbols-outlined text-4xl text-alerta mb-3">warning</span>
          <h2 className="font-display text-xl font-bold text-textprimary mb-2">No hay misión activa</h2>
          <p className="font-sans text-sm text-textsecondary mb-6">
            Creá una nueva misión para obtener tu perfil de eSIM Citrus Mobile.
          </p>
          <button
            type="button"
            onClick={() => navigate('/mission/new')}
            className="w-full py-3.5 rounded-full bg-primaryviolet text-white font-sans font-semibold text-xs uppercase tracking-wider shadow-md hover:bg-primaryviolet-hover transition-all"
          >
            NUEVA MISIÓN
          </button>
        </div>
      </div>
    )
  }

  const esim = mission.esim || {
    iccid: mission.iccid || `fake_${mission.id.slice(0, 8)}`,
    lpaString: `LPA:1$rsp.citrusmobile.com$ASTROAM_${mission.id.toUpperCase()}`,
    qrCode: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 200 200"><rect width="200" height="200" fill="%23FFFFFF" rx="16"/><rect x="20" y="20" width="40" height="40" fill="%236941FF"/><rect x="140" y="20" width="40" height="40" fill="%236941FF"/><rect x="20" y="140" width="40" height="40" fill="%236941FF"/><rect x="80" y="80" width="40" height="40" fill="%2300F0FF"/><text x="100" y="180" fill="%230F172A" font-size="10" font-family="sans-serif" text-anchor="middle">CITRUS eSIM</text></svg>`,
    directInstallUrl: `https://citrusmobile.com/install?iccid=${mission.iccid || mission.id}`,
    status: mission.esimStatus || 'active',
    isMock: mission.isMock ?? true,
  }

  const isDemo = esim.isMock ?? mission.isMock ?? true

  function copyToClipboard(text: string, type: 'lpa' | 'iccid') {
    void navigator.clipboard.writeText(text)
    if (type === 'lpa') {
      setCopiedLpa(true)
      setTimeout(() => setCopiedLpa(false), 2000)
    } else {
      setCopiedIccid(true)
      setTimeout(() => setCopiedIccid(false), 2000)
    }
  }

  const abbrevIccid = esim.iccid.length > 14
    ? `${esim.iccid.slice(0, 7)}...${esim.iccid.slice(-4)}`
    : esim.iccid

  return (
    <MobileAppShell title="INSTALACIÓN eSIM">
      {/* Title banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[11px] font-bold text-primaryviolet tracking-widest uppercase">
              [ CITRUS MOBILE // INSTALACIÓN ]
            </span>
            {isDemo && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/10 text-amber-600 border border-amber-500/20">
                MODO DEMO
              </span>
            )}
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-textprimary">
            INSTALÁ TU eSIM
          </h1>
          <p className="font-sans text-xs text-textsecondary mt-0.5">
            Tu conexión está lista para activar en tu dispositivo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full text-xs font-mono font-semibold bg-online/10 text-online border border-online/20 flex items-center gap-1.5 shrink-0">
            <span className="w-2 h-2 rounded-full bg-online animate-pulse" />
            DESTINO: {mission.destination.name} {mission.destination.flag}
          </span>
        </div>
      </div>

      {/* Layout Grid */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Left Column: QR Code & Install Buttons */}
        <div className="md:col-span-5 bg-white rounded-3xl border border-cardborder p-6 flex flex-col items-center justify-center text-center shadow-sm">
          <span className="font-mono text-xs font-bold text-textsecondary uppercase tracking-wider mb-4">
            CÓDIGO QR DE ACTIVACIÓN
          </span>

          {/* QR Container (white crisp background, 220-280px) */}
          <div className="relative p-4 bg-white rounded-2xl border border-cardborder mb-5 shadow-sm flex items-center justify-center">
            <img
              src={esim.qrCode}
              alt="eSIM QR Code"
              className="w-56 h-56 sm:w-60 sm:h-60 object-contain rounded-lg max-w-full"
            />
            {isDemo && (
              <div className="absolute inset-0 bg-bgdark/80 backdrop-blur-xs rounded-2xl flex flex-col items-center justify-center p-3 text-center">
                <span className="material-symbols-outlined text-tealbrand text-3xl mb-1">qr_code_2</span>
                <span className="font-mono text-xs font-bold text-white uppercase tracking-wider">
                  QR SIMULADO
                </span>
                <span className="font-sans text-[11px] text-textsecondary mt-1">
                  Usá el código LPA en modo demo
                </span>
              </div>
            )}
          </div>

          {/* Direct install button */}
          {esim.directInstallUrl && (
            <a
              href={esim.directInstallUrl}
              target="_blank"
              rel="noreferrer"
              className="w-full py-3.5 px-4 mb-3 rounded-2xl bg-primaryviolet text-white font-sans font-bold text-xs uppercase tracking-wider hover:bg-primaryviolet-hover transition-all flex items-center justify-center gap-2 shadow-[0_4px_14px_rgba(105,65,255,0.25)] min-h-[48px]"
            >
              <span className="material-symbols-outlined text-base">phone_iphone</span>
              INSTALAR EN ESTE IPHONE
            </a>
          )}

          <p className="font-sans text-xs text-textsecondary">
            Escaneá con la cámara de tu dispositivo o copiá el código LPA manualmente.
          </p>
        </div>

        {/* Right Column: LPA, ICCID & Manual Instructions */}
        <div className="md:col-span-7 flex flex-col gap-6">
          {/* Credentials Card */}
          <div className="bg-white rounded-3xl border border-cardborder p-6 shadow-sm">
            <h3 className="font-mono text-xs font-bold text-textsecondary uppercase tracking-wider mb-4">
              CREDENCIALES DE ACTIVACIÓN
            </h3>

            {/* LPA String */}
            <div className="mb-4">
              <label className="block font-mono text-[11px] text-textsecondary mb-1">CÓDIGO LPA (CADENA DE ACTIVACIÓN)</label>
              <div className="flex items-center gap-2 bg-bglight p-3 rounded-2xl border border-cardborder">
                <code className="font-mono text-xs text-textprimary break-all flex-1">
                  {esim.lpaString}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(esim.lpaString, 'lpa')}
                  className="px-3 py-2 rounded-xl bg-white border border-cardborder text-primaryviolet hover:bg-primaryviolet/5 font-mono text-xs font-semibold flex items-center gap-1 transition-all shrink-0 min-h-[40px]"
                >
                  <span className="material-symbols-outlined text-sm">
                    {copiedLpa ? 'check' : 'content_copy'}
                  </span>
                  {copiedLpa ? 'COPIADO' : 'COPIAR'}
                </button>
              </div>
            </div>

            {/* ICCID */}
            <div>
              <label className="block font-mono text-[11px] text-textsecondary mb-1">ICCID DE LA eSIM</label>
              <div className="flex items-center justify-between bg-bglight p-3 rounded-2xl border border-cardborder">
                <code className="font-mono text-xs text-textprimary font-semibold">
                  {abbrevIccid}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(esim.iccid, 'iccid')}
                  className="px-3 py-2 rounded-xl bg-white border border-cardborder text-primaryviolet hover:bg-primaryviolet/5 font-mono text-xs font-semibold flex items-center gap-1 transition-all shrink-0 min-h-[40px]"
                >
                  <span className="material-symbols-outlined text-sm">
                    {copiedIccid ? 'check' : 'content_copy'}
                  </span>
                  {copiedIccid ? 'COPIADO' : 'COPIAR'}
                </button>
              </div>
            </div>
          </div>

          {/* Instruction Steps */}
          <div className="bg-white rounded-3xl border border-cardborder p-6 shadow-sm flex-1">
            <div className="flex items-center justify-between mb-4 border-b border-cardborder pb-3">
              <h3 className="font-mono text-xs font-bold text-textsecondary uppercase tracking-wider">
                INSTRUCCIONES PASO A PASO
              </h3>
              <div className="flex bg-bglight p-1 rounded-full border border-cardborder">
                <button
                  type="button"
                  onClick={() => setActiveTab('iphone')}
                  className={`px-3 py-1.5 rounded-full font-mono text-xs font-bold transition-all ${
                    activeTab === 'iphone'
                      ? 'bg-primaryviolet text-white shadow-xs'
                      : 'text-textsecondary hover:text-textprimary'
                  }`}
                >
                  iOS (iPhone)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('android')}
                  className={`px-3 py-1.5 rounded-full font-mono text-xs font-bold transition-all ${
                    activeTab === 'android'
                      ? 'bg-primaryviolet text-white shadow-xs'
                      : 'text-textsecondary hover:text-textprimary'
                  }`}
                >
                  Android
                </button>
              </div>
            </div>

            {activeTab === 'iphone' ? (
              <ol className="space-y-3 font-sans text-xs text-textsecondary">
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
                  <span>Ingresá en <strong>Ajustes &gt; Red Celular &gt; Agregar eSIM</strong>.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
                  <span>Seleccioná <strong>Usar código QR</strong> y escaneá la imagen de arriba.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
                  <span>O elegí <strong>Ingresar datos manualmente</strong> y pegá el <strong>Código LPA</strong>.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">4</span>
                  <span>Activá la línea y asegurate de activar la opción <strong>Roaming de datos</strong> al viajar.</span>
                </li>
              </ol>
            ) : (
              <ol className="space-y-3 font-sans text-xs text-textsecondary">
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
                  <span>Abrí <strong>Ajustes &gt; Redes e Internet &gt; SIMs</strong>.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
                  <span>Tocá <strong>¿No tienes tarjeta SIM? / Descargar eSIM</strong>.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
                  <span>Escaneá el código QR o presioná <strong>Ayuda / Ingresar manualmente</strong> y pegá el LPA.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-primaryviolet/10 text-primaryviolet font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">4</span>
                  <span>Confirmá la descarga y activá la iterancia/roaming de datos.</span>
                </li>
              </ol>
            )}
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 bg-white p-4 sm:p-6 rounded-3xl border border-cardborder shadow-sm">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-online text-2xl">verified</span>
          <div>
            <p className="font-sans font-bold text-sm text-textprimary">
              Perfil provisto por Citrus Mobile
            </p>
            <p className="font-sans text-xs text-textsecondary">
              Tu wallet Soroban mantendrá la eSIM financiada en tiempo real.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate('/mission/active')}
          className="w-full sm:w-auto px-8 py-3.5 rounded-full bg-primaryviolet text-white font-sans font-semibold text-xs uppercase tracking-wider hover:bg-primaryviolet-hover transition-all shadow-[0_4px_14px_rgba(105,65,255,0.3)] hover:-translate-y-0.5 flex items-center justify-center gap-2 min-h-[48px]"
        >
          YA INSTALÉ MI eSIM // CONTINUAR AL DASHBOARD
          <span className="material-symbols-outlined text-base">arrow_forward</span>
        </button>
      </div>
    </MobileAppShell>
  )
}
