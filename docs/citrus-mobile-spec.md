# Spec v2: reemplazar Telnyx por Citrus Mobile (AstroAm)

Este documento es la **fuente única** para la migración. Reemplaza al spec v1 (`docs/citrus-mobile-spec.md`) y al plan derivado de él. Si algo choca con el README, prevalece la sección "Decisión: medir con el proveedor, sin gateway propio" del README, salvo donde este documento la precisa (marcado como **[precisión]**).

Referencia técnica de la API de Citrus: `citrus-mobile-brief.md`. Este spec define **qué construir y cuándo está hecho**; el brief explica cómo funciona Citrus.

---

## 1. Objetivo

Que toda la conectividad de AstroAm (provisión de eSIM, fondeo de su wallet, lectura de consumo, corte, devolución) funcione sobre **Citrus Mobile**, alimentando el flujo de vales de Stellar que ya existe, y retirar Telnyx.

## 2. Decisiones vigentes

| # | Decisión | Origen |
|---|---|---|
| D1 | No hay gateway propio. El consumo y el corte los hace Citrus. | README |
| D2 | El consumo se lee de Citrus (`total_data_charged_usd`) cada ~10 min y alimenta al medidor. | README |
| D3 | Se reemplaza la interfaz `ConnectivityProvider` por la forma Citrus. No conviven Telnyx y Citrus. | Decidido |
| D4 | `setDataLimit` se elimina. El tope lo da la wallet prepaga de la eSIM. | Decidido |
| D5 | Cableado condicional por `CONNECTIVITY_PROVIDER` en `server/main.ts`. Sin la variable, el comportamiento actual no cambia. | Decidido |
| D6 | Persistencia file-based (JSON/JSONL) con el patrón del repo. Sin SQL. | Decidido |
| D7 | El agente de vales, sus guardrails y la lógica de Stellar **no se tocan**. | Restricción |
| D8 | La eSIM es una por usuario y se reutiliza entre viajes. No se termina al cerrar un viaje. | README |

## 3. Alcance

**Dentro:** `CitrusProvider`/`CitrusClient`, fábrica y selector, adaptación del medidor y del `PolicyEnforcer`, secuencia de cierre, persistencia de eSIM, webhooks mínimos, config por zod, tests, demos y retiro de Telnyx.

**Fuera (no tocar):** `src/agent/*` (incluido `guardrails.ts`), servidor de cobro y canal (`src/server/channel-*`, `close-monitor`), `src/shared/stellar/*`, CosmoPay, `settle`. Los grupos de saldo compartido de Citrus (`/groups`) tampoco se usan: una SIM en grupo no tiene wallet ni consumo individual.

## 4. Estado actual del repo (commit `d310183`)

Hechos verificados en `main`:

- `ConnectivityProvider` expone `purchaseEsim | enable | disable | setDataLimit | getUsage → {mb, status}`. `TelnyxProvider` se usa solo en tests y demos; no está cableado en `server/main.ts`.
- `PolicyEnforcer.decidePolicy` decide `set_data_limit | disable | noop` sobre `balanceRaw − costRaw`. Lee `TELNYX_PRICE_PER_MB_USDC` de `process.env` (no pasa por zod).
- `IntegratedMeterService.processTraffic(bytes)` acumula bytes de un `NetworkDataMeter` simulado, pide el vale (`POST /vouchers`) y aplica la política. Exige `arePricesAligned(pricePerMbRaw, voucherPricePerMibRaw)`.
- **El agente de vales exige que `cumulativeAmount == ceil(cumulativeBytes × PRICE_PER_MIB_RAW / 1048576)`, igualdad exacta** (`src/agent/guardrails.ts`). Por eso el sistema sigue hablando en bytes.
- `createStellarChannelBalanceAdapter` devuelve el **depósito acumulado** del canal en raw (1e-7 USDC), no el saldo restante.
- Utilidades reutilizables: `createChannelMutex().withChannelLock(key, fn)` (`src/shared/mutex.ts`, sirve para cualquier clave), `withRetry`/`withTimeout` (`src/shared/retry.ts`), patrón de escritura atómica `.tmp+fsync+rename` (`src/persistence/channel-record.ts`).
- `src/jobs/reconciliation.ts` compara `getUsage().mb` contra bytes del gateway. `ConnectivitySession` tiene `provider: "telnyx"` y `carrierBytes`.
- Los demos (`scripts/demo-flow.ts`, `demo-cosmopay-flow.ts`) usan un proveedor mock con la interfaz vieja. `.env.example` tiene la sección Telnyx (líneas ~151–173).
- Stack: Node ≥22.18 ejecutando `.ts` directo, TypeScript ESM estricto, tests con `node:test`. Comandos: `npm run check`, `npm test`.

## 5. Restricciones de Citrus

- **C1.** Prepago en USD. Cada eSIM tiene wallet propia; al llegar a $0 la red corta los datos.
- **C2.** Sin endpoint de bytes. El consumo llega en USD: `total_data_charged_usd` es **acumulado de por vida de la SIM** (no por viaje).
- **C3.** Retraso de ~10 a 15 min en consumo y saldo. Tras cada `fund`, el reporte se pausa ~15 min.
- **C4.** `defund` es asíncrono: responde 202, pausa los datos de inmediato y acredita a la cuenta reseller en ~15 min (`esim.defunded`). Mientras dura no se puede `fund` ni `enable` esa SIM. No termina la SIM.
- **C5.** `wallet_balance_usd` se redondea hacia abajo hasta ~5¢. El monto devuelto por `defund` es el saldo mostrado.
- **C6.** Rate limit 100 req/min por key. Sin idempotency keys documentadas.
- **C7.** Sin sandbox (README): las pruebas usan dinero real.
- **C8.** `terminate` es irreversible y pierde el saldo restante.

## 6. Modelo de facturación

Citrus le cobra al revendedor a tarifa retail −10%. Al viajero se le cobra retail × 1,35. Por lo tanto **el viajero paga 1,5 veces lo que Citrus descuenta de la wallet** (`MARKUP = 1,5`; margen ≈ 33%).

### 6.1 Definiciones (todo en enteros `bigint`, sin `float`)

- `chargedMicroUsd`: `total_data_charged_usd` convertido a micro-USD en el borde del proveedor.
- `chargedBaselineMicroUsd`: lectura de `total_data_charged_usd` al abrir el canal. Consumo del viaje: `chargedSession = charged − baseline` (nunca decreciente).
- `MARKUP_BPS = 15000`, `USDC_USD_RATE_BPS = 10000` (1 USDC = 1 USD, ver §12).
- `PRICE_PER_MB_RAW` (renombrado desde `TELNYX_PRICE_PER_MB_USDC`) y `PRICE_PER_MIB_RAW`, alineados como hoy.

### 6.2 Bytes equivalentes **[precisión]**

El README dice "bytes = USD cobrados ÷ tarifa del país". Se implementa derivando la conversión del propio precio y del markup, sin tabla por país:

```
equivalentBytes = floor( chargedSessionMicroUsd × MARKUP_BPS × 10_000_000
                         / (USDC_USD_RATE_BPS × PRICE_PER_MB_RAW) )
```

Con esa fórmula, `equivalentBytes × PRICE_PER_MB_RAW` da exactamente `chargedSession × MARKUP` en USDC, así que **el cobro sigue a lo que Citrus descuenta, sin importar país ni operador**. Los "bytes" son una unidad de cuenta para el agente de vales; solo se parecen a bytes reales en el país cuya tarifa es `PRICE_PER_MB_RAW`. La UI debe mostrar USDC gastados, no MB.

Ejemplo (Brasil, `PRICE_PER_MB_RAW = 25000`): consumo de $3,60 → 2 160 000 000 bytes equivalentes → 2160 MB × 25000 = 54 000 000 raw = **5,4 USDC = 3,60 × 1,5**.

### 6.3 Invariantes

- **I1 (facturación).** El monto acumulado del vale por `equivalentBytes` es ≈ `chargedSession × MARKUP` (± redondeo del `ceil` por MiB, ≤ 0,01%).
- **I2 (tope de wallet).** La suma fondeada a la eSIM en el viaje no supera:
  ```
  maxWalletCents = floor( depositRaw × USDC_USD_RATE_BPS / (100_000 × MARKUP_BPS) )
  ```
  Ejemplo: depósito de 5 USDC (50 000 000 raw) → 333 centavos ($3,33). Con I1 e I2, el viajero nunca puede consumir más de lo depositado y el canal no se sobregira.

## 7. Requisitos

Cada uno con criterio de aceptación (CA).

**R1. Selector y fábrica.** `createConnectivityProvider()` resuelve por `CONNECTIVITY_PROVIDER` (`fake | citrus`, **default `fake`**). Falla rápido con mensaje accionable si falta config de Citrus.
- CA: sin la variable, servidor, tests y demos se comportan como hoy; con `citrus` y sin `CITRUS_API_KEY`, el arranque falla nombrando la variable.

**R2. Interfaz nueva.** Reemplaza a la actual; `setDataLimit` desaparece.
```ts
type EsimRecord = { iccid: string; lpaString: string; qrCode: string; directInstallUrl: string; status: string };
type SimUsage   = { chargedMicroUsd: bigint; walletMicroUsd: bigint; status: string; asOf: string };
interface ConnectivityProvider {
  provisionEsim(userRef: string, label?: string): Promise<EsimRecord>;
  topUp(iccid: string, amountCents: number): Promise<void>;
  getUsage(iccid: string): Promise<SimUsage>;
  suspend(iccid: string): Promise<void>;
  resume(iccid: string): Promise<void>;
  refundUnused(iccid: string): Promise<void>;   // defund
  terminate(iccid: string): Promise<void>;
}
```
`simCardId === iccid`. Un `FakeProvider` implementa la misma interfaz para tests y demos.
- CA: `npm run check` en verde; ningún archivo referencia `setDataLimit`, `purchaseEsim` ni `mb` del proveedor.

**R3. `CitrusClient`.** Cliente HTTP fino (reutilizar el patrón `HttpClient` de `TelnyxProvider`): base URL configurable, `Authorization: Bearer rsk_…`, limitador de tasa (presupuesto ≤ 80 req/min), reintentos con `withRetry`.

| Código | Comportamiento |
|---|---|
| 429 | Reintentar respetando `Retry-After` |
| 502, 503 (`NO_ESIMS_AVAILABLE`) | Reintentar con backoff y tope |
| 400, 401, 404, 409 | No reintentar; error de dominio |
| 402 `INSUFFICIENT_BALANCE` | `CitrusResellerBalanceError` (alerta operativa, no error del usuario) |
| Timeout en `fund` | No reintentar a ciegas (ver R5) |

- CA: prueba por tabla de códigos con respuestas mockeadas; la key nunca aparece en logs.

**R4. Provisión idempotente.** `provisionEsim(userRef)` llama `POST /esim/provision` con `end_user_reference=userRef`. Si el usuario ya tiene una eSIM con estado ≠ `terminated`, la reutiliza. Un lock por `userRef` (`createChannelMutex` con clave `esim:${userRef}`) evita provisiones duplicadas concurrentes.
- CA: dos llamadas simultáneas con el mismo `userRef` producen una sola eSIM y un solo cargo de provisión.

**R5. Fondeo de la wallet.** Se fondea **una vez al abrir el canal** y **otra vez si el canal recibe un top-up**, sin fondeo por tramos. El monto es el hueco hasta `maxWalletCents` (I2) menos lo ya fondeado en el viaje, en centavos enteros. Antes de `POST /fund` se persiste `pendingFund`; tras la respuesta se confirma. Tras un timeout o caída, se reconcilia con `GET /esim/{iccid}` comparando `wallet_balance_usd` contra el valor previo, en lugar de reintentar.
- CA: wallet fondeada × MARKUP ≤ depósito en todos los casos de prueba; un timeout simulado no duplica el fondeo; un crash entre `pendingFund` y la respuesta se resuelve al reiniciar.

**R6. Lectura de consumo.** Un lazo lee `getUsage(iccid)` cada `USAGE_POLL_INTERVAL_MS` (default 600 000; mínimo 60 000; el dato no mejora por debajo de ~5 min). Mantiene `chargedBaselineMicroUsd` (guardado al abrir el canal, ver R9 sobre cuándo leerlo) y calcula `equivalentBytes` con §6.2, con monotonicidad (`max` con la lectura previa).
- CA: con lecturas mockeadas, `equivalentBytes` coincide con la fórmula del ejemplo de §6.2; una lectura menor a la anterior no reduce el acumulado.

**R7. Vales.** El medidor recibe `equivalentBytes` acumulados y pide el vale por el flujo actual (`requestVoucher` → `POST /vouchers`). Se agrega un método idempotente en `IntegratedMeterService` (por ejemplo `processCumulative(cumulativeBytes)`) que reutiliza `requestVoucher`, `creditIfSigned` y `decidePolicy`; `processTraffic` se conserva para los demos. **No se modifica el agente ni `PRICE_PER_MIB_RAW`.** `arePricesAligned` se mantiene.
- CA: un vale por `equivalentBytes` es aceptado por el agente real en un test de integración local; la cuota solo se acredita con vale firmado.

**R8. Corte.** `PolicyEnforcer` elimina la acción `set_data_limit` y el umbral bajo. Si el saldo restante del canal llega a 0 (o no cubre 1 MB equivalente), o el agente rechaza un vale de forma no reintentable (`channel_exhausted`, `channel_closing`), se llama `suspend()`. **Nunca noop.** Sirve de respaldo: el corte natural lo da la wallet (I2).
- CA: test de regresión: canal sin saldo → `suspend` invocado; el cost basis usa los mismos `equivalentBytes` que el vale.

**R9. Cierre del viaje.** Secuencia en un componente nuevo (por ejemplo `SessionCloser`) que usa el puerto de cierre existente del servidor, sin modificarlo:
1. `refundUnused(iccid)` (`defund`): pausa datos, `defund_pending` bloquea `topUp`/`resume`.
2. Esperar `esim.defunded` (o polling de respaldo con timeout; ver §12).
3. Consumo final = `charged` leído **después** de la liquidación − `baseline`. Control cruzado: `fondeado − returned_usd` (tolerancia ≤ 5¢ por redondeo, C5). Si difieren más, alerta y se usa el menor.
4. Pedir el último vale por el consumo final; el servidor cobra y el resto vuelve al viajero (flujo existente).
5. La eSIM queda `idle` e instalada (D8). `terminate` solo se permite con wallet 0 y sin `defund` pendiente, y no forma parte del flujo normal.
- CA: en un test con `FakeProvider` con retraso simulado, el último vale refleja el consumo posterior a la liquidación; `terminate` con saldo > 0 es rechazado localmente.

El `baseline` del viaje siguiente se lee justo antes del primer `fund`, con la SIM sin tráfico y sin `defund` pendiente. Como `defund` pausa datos y ya liquidó, la lectura no queda atrasada.

**R10. Webhooks (mínimo).** Ruta `POST /citrus/webhooks` con `express.raw({ type: "application/json" })` montada solo si `CONNECTIVITY_PROVIDER=citrus`, sin afectar otras rutas (única modificación en `app.ts` o `main.ts`). Verifica la firma HMAC-SHA256 del **body crudo** con `CITRUS_WEBHOOK_SECRET` contra `X-Citrus-Signature`, en tiempo constante, aceptando hex con o sin prefijo `sha256=` (Citrus no documenta el formato). Firma inválida → 401. **Persistir el evento en el JSONL antes de responder 200**, luego procesar; al arrancar, reprocesar los no marcados `processed_at` y reconstruir el set de dedup por `id`. Eventos tratados: `esim.defunded` y `esim.balance_depleted`; el resto se registra y se responde 200. El resto de los eventos (`esim.activated`, `balance.*`, etc.) queda diferido.
- CA: un evento con firma válida se procesa una vez aunque llegue dos veces; con firma inválida se rechaza; `POST /webhooks/{id}/test` devuelve 200 contra el servidor levantado.

**R11. Persistencia file-based.** `src/persistence/esim-record.ts` (mapa `iccid → { userRef, channelId, status, fundedMicroUsd, pendingFund, chargedBaselineMicroUsd, defundPending, createdAt }`) y `src/persistence/webhook-event.ts` (JSONL append-only). Escritura atómica con el patrón de `channel-record.ts`; escrituras del mapa serializadas con `createChannelMutex`.
- CA: dos escrituras concurrentes al mismo registro no pierden datos; reinicio conserva el dedup.

**R12. Configuración por zod.** En `src/config/env.ts` (`sharedSchema`), reutilizando `rawPositiveIntegerRaw()`:

| Variable | Notas |
|---|---|
| `CONNECTIVITY_PROVIDER` | `fake \| citrus`, default `fake` |
| `CITRUS_API_KEY` | prefijo `rsk_`; requerida solo con `citrus` |
| `CITRUS_BASE_URL` | default `https://citrusmobile.com/api/v2/reseller` |
| `CITRUS_WEBHOOK_SECRET` | prefijo `whsec_`; requerida solo si se montan webhooks |
| `PRICE_PER_MB_RAW` | renombre de `TELNYX_PRICE_PER_MB_USDC`; misma semántica y alineación con `PRICE_PER_MIB_RAW` |
| `MARKUP_BPS` | default 15000 |
| `USDC_USD_RATE_BPS` | default 10000 |
| `USAGE_POLL_INTERVAL_MS` | default 600000; mín 60000 |

`.env.example` reemplaza la sección Telnyx por Citrus, sin valores reales. Actualizar mensajes y comentarios que nombran a Telnyx.
- CA: `grep -ri "TELNYX_PRICE_PER_MB_USDC"` vacío; valores inválidos fallan al arrancar nombrando la variable.

**R13. Reconciliación reutilizada.** `src/jobs/reconciliation.ts` deja de comparar contra el gateway y pasa a contrastar dos cifras de Citrus: `charged − baseline` contra `fondeado − walletUsd`. Solo diagnóstico: registra la diferencia (tolerancia ≥ 5¢ + lag), nunca lanza ni afecta la facturación. `ConnectivitySession` pasa a `provider: "citrus"`, elimina `carrierBytes` y agrega `chargedMicroUsd`, `chargedBaselineMicroUsd`, `fundedMicroUsd`.
- CA: con lecturas mockeadas el job loguea la diferencia y no lanza ante errores del proveedor.

**R14. Tests y demos.** Tests de contrato con fixtures del OpenAPI; tabla de errores; timeout en `fund`; invariantes I1 e I2; `PolicyEnforcer` con `suspend`; secuencia de cierre; webhook duplicado y firma inválida; concurrencia de `provisionEsim` y de escrituras. `demo:flow` y `demo:cosmopay` siguen corriendo sin red usando `FakeProvider`.
- CA: `npm run check` y `npm test` en verde.

**R15. Retiro de Telnyx.** Último commit, **solo después de la prueba de humo (T9)**: borrar `TelnyxProvider.ts` y su test, `docs/telnyx-wireless-integracion.md`, variables `TELNYX_*`; actualizar el README (checklist "Falta" y sección Proveedor).
- CA: `grep -ri telnyx` vacío en código y config (queda en el historial de git).

## 8. Diseño

**Componentes nuevos:** `providers/connectivity/{CitrusClient,CitrusProvider,FakeProvider,createConnectivityProvider}.ts`, `shared/{token-bucket,citrus-errors}.ts`, `services/{SessionCloser,CitrusWebhookHandler,FundingService}.ts`, `server/routes/citrus-webhooks.ts`, `persistence/{esim-record,webhook-event}.ts`.

**Modificados (ajuste mínimo):** `ConnectivityProvider.ts`, `ConnectivitySession.ts`, `PolicyEnforcer.ts`, `meter-service.ts`, `reconciliation.ts`, `config/env.ts`, `.env.example`, `server/main.ts` (una sola llamada de registro), `scripts/demo-*.ts`.

**Flujo de un viaje**

1. **Apertura.** Depósito USDC → canal Soroban abierto → `provisionEsim` (o se reutiliza) → leer `baseline` → `topUp` a `maxWalletCents` (I2) → entregar QR / `directInstallUrl` al viajero.
2. **Medición (cada ~10 min).** `getUsage` → `chargedSession` → `equivalentBytes` → vale firmado → cuota acreditada → `PolicyEnforcer` evalúa.
3. **Top-up del canal.** Nuevo hueco hasta el nuevo `maxWalletCents` → `topUp` por la diferencia.
4. **Cierre.** R9.

**Estados internos de la eSIM:** `provisioned → active → (cut) → defund_pending → idle → active …`; `terminated` solo por operación explícita.

## 9. Plan de tareas

| # | Tarea | Depende de | Hecha cuando |
|---|---|---|---|
| T1 | Interfaz nueva + `FakeProvider`; adaptar consumidores y demos (R2, R14 parcial) | — | `npm run check` y demos en verde |
| T2 | Config zod y selector (R1, R12) | T1 | CA de R1 y R12 |
| T3 | `CitrusClient` y `CitrusProvider` (R3, R4) | T1 | Tests de contrato y errores |
| T4 | Persistencia `esim` y `webhook-event` (R11) | T1 | CA de R11 |
| T5 | Bytes equivalentes, `processCumulative`, lazo de lectura (R6, R7) | T1, T4 | CA de R6, R7 |
| T6 | `FundingService` (R5) y `PolicyEnforcer` sin `set_data_limit` (R8) | T3, T4, T5 | CA de R5, R8 |
| T7 | `SessionCloser` (R9) y reconciliación reutilizada (R13) | T5, T6 | CA de R9, R13 |
| T8 | Webhooks mínimos (R10) | T4, T7 | CA de R10 |
| T9 | Prueba de humo real (§10) | T2 a T8 | Ciclo completo ejecutado y documentado |
| T10 | Retirar Telnyx y actualizar docs (R15) | T9 | CA de R15 |

## 10. Prueba de humo (T9)

Con dinero real (C7). Antes de correrla, confirmar en el dashboard el costo de la eSIM y la recarga mínima (ver §12). Ciclo: 1 eSIM provisionada, fondeo de $9, instalación, consumo real, `defund`, `esim.defunded`, comparación de `charged − baseline` contra `fondeado − returned`. Debe validar la precisión de `total_data_charged_usd`, el formato de la firma del webhook y la detección del fin del `defund`.

## 11. Notas de implementación

- Tratar `wallet_balance_usd` como "al menos" ese saldo (C5). Montos de fondeo en centavos enteros.
- Convertir los USD de la API a micro-USD `bigint` en un solo lugar (el borde de `CitrusProvider`); nada de `float` aguas adentro.
- La key y el secret nunca se loguean; enmascarar `Authorization`.
- Un solo canal activo por eSIM a la vez.
- Toda decisión que dependa de consumo o saldo tolera datos de hasta ~15 min de antigüedad.

## 12. Preguntas abiertas y riesgos

1. **Costos reales.** El README dice "primera eSIM gratis, USD 2,45 después" y "recarga mínima USD 4"; la documentación de la API del revendedor dice **$1,75 por eSIM** y **$10 de recarga mínima**. Confirmar en el dashboard antes de presupuestar T9.
2. **Precisión de `total_data_charged_usd`** (el README ya pide confirmarla): centavos, o hasta el KB. Se valida en T9.
3. **Fin del `defund` sin webhook.** La API no documenta un indicador de `defund` pendiente en `GET /esim/{iccid}`. Definir el polling de respaldo (¿wallet en 0 y consumo estable?) y su timeout en T9.
4. **Formato de la firma del webhook** (hex, base64 o con prefijo). Cubierto por la comparación tolerante de R10; confirmar con `POST /webhooks/{id}/test`.
5. **`USDC_USD_RATE_BPS`.** Se asume 1 USDC = 1 USD. Confirmar o cotizar.
6. **"Bytes equivalentes" vs "tarifa del país" del README** (§6.2): la fórmula es equivalente en cobro y evita mantener tarifas por país. Confirmar con el equipo que no se necesita mostrar MB reales al viajero.
7. **Puerto de cierre.** Ubicar el punto de entrada existente del servidor de cobro para cerrar el canal (`src/server/channel-admin.ts` u otro) sin modificarlo; si no existe uno adecuado, definir un puerto mínimo y registrarlo aquí.
8. **`NetworkDataMeter`.** El simulador de gateway (`demo-meter.ts`) sigue siendo la base de `processTraffic` para los demos. Decidir si su cuota impaga sigue aplicando en modo Citrus o se reemplaza por R8.
9. **Riesgo de retraso (C3).** Mitigado por la wallet prepaga (I2), pero un viajero puede consumir hasta ~15 min de datos antes de que el medidor lo vea; por eso el tope de wallet es la protección primaria y el `PolicyEnforcer` solo respaldo.
10. **Proveedor nuevo.** Sin SLA visible; sin sandbox. Mantener `FakeProvider` para desarrollo y demos.

## 13. Referencias

- Brief técnico: `citrus-mobile-brief.md`
- OpenAPI: https://citrusmobile.com/openapi-reseller.yaml
- Docs en Markdown: https://citrusmobile.com/developer/docs/markdown
- Recetas: https://citrusmobile.com/developer/guides
- MCP oficial (tarifas y docs sin key): `https://citrusmobile.com/api/mcp`
- Tarifas públicas: https://citrusmobile.com/rates
- Soporte: support@citrusmobile.com