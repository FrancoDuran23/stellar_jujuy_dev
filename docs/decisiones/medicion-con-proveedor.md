# Decisión: medir con el proveedor, sin gateway propio

**Fecha:** 24/9/2026 · **Estado:** implementada (migración a Citrus Mobile, PR #9)

**Contexto.** El diseño original (ver [`docs/citrus-mobile-brief.md`](../citrus-mobile-brief.md)
y [`docs/citrus-mobile-spec.md`](../citrus-mobile-spec.md)), que la
migración a Citrus reemplazó, medía los bytes en un gateway propio con
WireGuard: todo el tráfico del viajero pasaba por un servidor nuestro, como una
VPN. Ese gateway nunca se construyó (`src/meter/demo-meter.ts` lo simula) y
costaría servidores en varias regiones, latencia extra, una VPN que el viajero
tiene que activar y tener todo su tráfico pasando por nosotros.

**Decisión.** Somos un revendedor liviano: gestionamos la eSIM por API, pero
la medición y el corte los hace el proveedor. Nos quedamos con lo que es
nuestro: el canal de Stellar, los vales y el reembolso.

**Consecuencias.**

- El medidor lee el consumo del proveedor en vez de un gateway. Esto
  reemplaza la regla "facturamos solo con los bytes del gateway" del diseño
  original.
- Citrus informa el consumo en **USD cobrados** (`total_data_charged_usd`),
  no en bytes. Los bytes se calculan como USD cobrados ÷ tarifa del país.
  Hay que confirmar la precisión con una cuenta real.
- Hay un desfase de ~10 minutos entre el uso y el vale. El riesgo queda
  acotado por la billetera prepaga de la eSIM: nunca se usa más de lo que se
  cargó.
- Confiamos en los números del proveedor. La reconciliación
  (`src/jobs/reconciliation.ts`) deja de comparar contra el gateway.
- La API de Citrus permite 100 pedidos por minuto. Con una lectura cada 10
  minutos alcanza para ~1.000 eSIMs activas; más allá, hay que usar webhooks
  (`esim.balance_low`, `esim.balance_depleted`) o grupos.
- Citrus no tiene sandbox: las pruebas se hacen con plata real (recarga
  mínima USD 4).

**Opciones descartadas.**

- **Revendedor completo con gateway propio:** lo más caro de construir y
  operar, y empeora la experiencia del viajero.
- **Solo sistema de pago** (otro vende la eSIM e integra nuestro canal): lo
  más simple de operar, pero depende de conseguir socios. Queda como camino
  B2B a futuro, por ejemplo con wallets del ecosistema Stellar.
