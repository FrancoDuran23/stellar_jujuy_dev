# AstroAm

Datos móviles para viajeros en cualquier país, pagados por MB con USDC sobre
Stellar. El viajero deposita en un canal de pago de Soroban, usa datos con una
eSIM y paga solo lo que consume: lo que no gastó vuelve a su wallet cuando se
cierra el canal.

Proyecto del hackatón Stellar Apex (equipo AstroAm).

## Cómo funciona

1. **Fondeo.** El viajero carga USDC (con su wallet o con CosmoPay) y abre un
   canal de pago de una sola vía en Soroban con ese depósito.
2. **eSIM.** Pedimos una eSIM al proveedor por API y le damos el QR al
   viajero. La eSIM queda instalada para próximos viajes.
3. **Saldo en la eSIM.** Cargamos en la billetera de la eSIM (del lado del
   proveedor) lo que cubre el depósito del canal. El proveedor corta los datos
   solo cuando esa billetera se vacía.
4. **Medición y vales.** Cada ~10 minutos leemos el consumo de la eSIM en la
   API del proveedor y el medidor le pide al agente de pagos un vale firmado
   por el acumulado (`POST /vouchers`). La cuota solo se acredita con un vale
   firmado.
5. **Cierre.** El servidor cobra con el último vale; el resto del depósito
   vuelve al viajero. Retiramos lo que quedó en la billetera de la eSIM y la
   deshabilitamos.

## Decisión: medir con el proveedor, sin gateway propio

**Fecha:** 24/9/2026 · **Estado:** decidida, pendiente de implementar

**Contexto.** El diseño original (ver [`docs/citrus-mobile-brief.md`](docs/citrus-mobile-brief.md)
y [`docs/citrus-mobile-spec.md`](docs/citrus-mobile-spec.md)), que la
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

## Proveedor y precio

- **Proveedor elegido: Citrus Mobile.** Cobra por uso real (hasta el KB), sin
  packs ni vencimiento, en 218 países, con API para revendedores: crear eSIM,
  habilitar/deshabilitar, billetera por eSIM (`fund`/`defund`) y consumo.
  Primera eSIM gratis; USD 2,45 cada una después.
- **Telnyx** fue descartado y retirado del repo: USD 12,50/GB en su mejor
  tramo, entre 7 y 20 veces más caro que Citrus.
- **Precio al viajero:** tarifa pública de Citrus del país × 1,35 (≈ 33% de
  margen sobre la tarifa de revendedor, que es 10% más baja).

| País | Citrus (USD/GB) | AstroAm (USD/GB) | USDC/MB |
|---|---:|---:|---:|
| Brasil | 1,84 | 2,48 | 0,0025 |
| Argentina | 1,89 | 2,55 | 0,0026 |
| México | 2,00 | 2,70 | 0,0027 |
| EE.UU. | 0,97 | 1,31 | 0,0013 |
| España, Italia, Francia, Reino Unido | 0,61 | 0,82 | 0,0008 |

Tarifas públicas de [citrusmobile.com/rates](https://citrusmobile.com/rates),
consultadas el 23/9/2026. Chile, Perú, Colombia y Bolivia no están
publicadas: se ven con cuenta (`GET /rates`).

El precio se configura dos veces y las dos tienen que ser la misma tarifa:
`PRICE_PER_MB_RAW` (por MB, para la política de corte) y `PRICE_PER_MIB_RAW`
(por MiB, para los vales). Para Brasil: `25000` y `26215`. El medidor no
arranca si no coinciden.

## Estado

**Hecho**

- Pagos MPP en Stellar: cobro puntual (etapa 1) y canal de pago con vales
  firmados, cierre y monitor de disputas (etapa 2), probados en testnet.
- Integración con Citrus Mobile: eSIMs, política de corte (suspend/noop) y
  reconciliación.
- Medidor integrado con el agente de pagos: solo acredita con vale firmado.
- Fondeo con CosmoPay en testnet (cae a modo simulado si falla la API).
- Demos `demo:flow` y `demo:cosmopay` con el precio real de Brasil.

**Falta**

- [x] `CitrusProvider` con la interfaz `ConnectivityProvider` (client, fábrica
      y selector, `FakeProvider` para dev y demos).
- [x] Consumo del proveedor (usage-loop + reconciliación) en lugar del gateway.
- [x] Política de corte adaptada: suspender/resumir la eSIM vía `suspend`, en
      lugar de `setDataLimit`.
- [x] Retiro completo de Telnyx (R15).
- [ ] Entregar el QR de la eSIM al viajero (interfaz).
- [ ] `settle` (cobros parciales): el wasm desplegable hoy no lo tiene.
- [ ] Para calificar al SCF: demo pública, 3 entregables verificados e
      Instaward.

## Estructura

```
src/
  agent/        agente de pagos (funder): firma vales, POST /vouchers
  server/       servidor de cobro (recipient): canal, cierre, monitor
  shared/       precios, mensajes, razones, reintentos, Stellar
  persistence/  registro de vales y del canal
  config/       variables de entorno y arranque
  providers/    proveedores de eSIM (ConnectivityProvider, CitrusProvider)
  services/     PolicyEnforcer, CosmoPayService
  jobs/         reconciliación de consumo
  meter/        medidor integrado y cliente de vales
  models/       sesión de conectividad
scripts/        demos, preflight y verificación de depósitos
docs/           diseño y guías
```

## Cómo correrlo

1. Node `>=22.18` (ejecuta `.ts` directo, sin build).
2. `npm install`
3. `cp .env.example .env` y completar los valores (cada uno está comentado).
4. `npm run check` (tipos) y `npm test` (tests).

Demos, sin red ni claves:

- `npm run demo:flow`: viajero en Florianópolis, 4 tramos de consumo, vales
  firmados, tope bajado y corte al agotar el depósito. Con
  `AGENT_VOUCHERS_URL` usa el agente de pagos real.
- `npm run demo:cosmopay`: el mismo flujo, fondeado con CosmoPay.

Servidor, agente y canal en testnet: ver
[`docs/payments-mpp-operacion.md`](docs/payments-mpp-operacion.md).

## Documentación

- [`docs/sdd/payments-mpp.md`](docs/sdd/payments-mpp.md): requisitos,
  diseño y evidencia en testnet del componente de pagos.
- [`docs/payments-mpp-operacion.md`](docs/payments-mpp-operacion.md): cómo
  operar el servidor, el agente y el canal.
- [`docs/citrus-mobile-brief.md`](docs/citrus-mobile-brief.md) y
  [`docs/citrus-mobile-spec.md`](docs/citrus-mobile-spec.md): brief y spec de
  la migración a Citrus Mobile. La parte del gateway propio quedó reemplazada
  por la decisión de arriba.
