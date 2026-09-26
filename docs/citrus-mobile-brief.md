# Citrus Mobile: brief para reemplazar Telnyx

Objetivo: reemplazar la infraestructura de conectividad de Telnyx por Citrus Mobile en la app de eSIM + micropagos USDC en Stellar. Implementar Citrus detrás de la interfaz `ConnectivityProvider`, sin atar la lógica de Stellar al proveedor.

## Fuentes

- Docs en Markdown: https://citrusmobile.com/developer/docs/markdown
- OpenAPI: https://citrusmobile.com/openapi-reseller.yaml
- Recetas con código: https://citrusmobile.com/developer/guides
- Servidor MCP oficial (streamable HTTP): `https://citrusmobile.com/api/mcp`
  - Sin key: tarifas, cobertura, estimación de costos y búsqueda en docs.
  - Con `Authorization: Bearer rsk_...`: provisionar, fondear, listar e inspeccionar eSIMs.
  - Claude Code: `claude mcp add --transport http citrus https://citrusmobile.com/api/mcp --header "Authorization: Bearer rsk_YOUR_KEY"`
- Soporte: support@citrusmobile.com

## Modelo

- Conectividad prepaga. Cada eSIM tiene una **wallet en USD**. El consumo la vacía a la tarifa por MB/GB de cada operador y país.
- Cuando la wallet llega a $0, la red corta los datos sola. El gasto máximo de una SIM es lo que se le fondeó.
- No hay planes ni bundles. Una eSIM funciona en todos los países.
- Reutilizar la eSIM entre viajes evita pagar de nuevo los $1.75 de provisión.

## Costos

- API gratis, sin mensualidad.
- **$1.75 por eSIM provisionada.**
- Datos a **10% menos que el retail**. Descuentos por volumen desde $1k/mes.
- Cuenta de reseller: recarga mínima de **$10** (dashboard, pago con Stripe).
- Ejemplo: Japón desde $1.38/GB (KDDI). Tarifas por país y operador en `GET /rates`.

## API v2

- Base: `https://citrusmobile.com/api/v2/reseller`
- Auth: `Authorization: Bearer rsk_...` (68 caracteres).
- Rate limit: **100 req/min por key**. Si se excede, 429 con header `Retry-After`.

| Acción | Endpoint |
|---|---|
| Provisionar | `POST /esim/provision` (opcionales: `end_user_reference`, `label`, `group_id`) |
| Fondear | `POST /esim/{iccid}/fund` con `{amount}` (USD, 0.01 a 10000) |
| Detalle / listar | `GET /esim/{iccid}`, `GET /esim/list?status=&limit=&offset=` |
| Pausar / reanudar | `POST /esim/{iccid}/disable`, `POST /esim/{iccid}/enable` |
| Devolver saldo no usado | `POST /esim/{iccid}/defund` |
| Terminar | `POST /esim/{iccid}/terminate` |
| Limitar velocidad | `POST /esim/{iccid}/throttle` con `{speed}` (`NO_LIMIT`, `SPEED_100_KBPS` … `SPEED_5000_KBPS`) |
| Cuenta | `GET /wallet/balance`, `GET /account`, `GET /rates?country=&continent=` |
| Webhooks | `GET/POST /webhooks`, `GET/PUT/DELETE /webhooks/{id}`, `POST /webhooks/{id}/test` |
| Grupos (saldo compartido) | `/groups` y subrutas |

### `POST /esim/provision`

- Devuelve: `id`, `iccid`, `lpa_string`, `qr_code` (PNG base64 como data URL), `direct_install_url` (iOS 17.4+, un toque), `status`, `euicc_state`, `group_id`, `cost`, `balance_remaining`, `created_at`.
- La SIM nace con **wallet en $0**. Sin `fund` no pasa datos.
- Entregar el QR o el link de instalación al usuario es responsabilidad de la app.

### `GET /esim/{iccid}`

- `wallet_balance_usd`: saldo restante de la wallet.
- `total_data_charged_usd`: consumo acumulado en USD a las tarifas de `/rates`.
- `status`: `pending | active | suspended | terminated`.
- `euicc_state`: `RELEASED | DOWNLOADED | INSTALLED | ENABLED`.

### Errores

`INVALID_API_KEY` (401), `INSUFFICIENT_BALANCE` (402), `ESIM_NOT_FOUND` (404), `ESIM_ALREADY_TERMINATED` (400), `VALIDATION_ERROR` (400), `NO_ESIMS_AVAILABLE` (503, reintentar), `ESIM_IN_GROUP`, `DEFUND_ALREADY_PENDING` (409), `NO_BALANCE_TO_RETURN` (400), `WALLET_NOT_READY` (400), `RATE_LIMITED` (429).

## Webhooks

- URL HTTPS. Máximo 5 por cuenta. Se auto-desactivan tras 10 fallos consecutivos.
- El `signing_secret` (`whsec_...`) se devuelve **una sola vez** al registrar el webhook. Guardarlo.
- Verificación: HMAC-SHA256 del **body crudo** con el `signing_secret`, comparado contra el header `X-Citrus-Signature`.
- Envelope: `{ id, event, created_at, data }`.
- Suscripción a eventos puntuales o a `["*"]`.
- No documentan timestamp ni protección contra replay. Deduplicar por `id` del evento.

| Evento | Cuándo |
|---|---|
| `esim.provisioned` | Se provisionó la eSIM |
| `esim.activated` | El usuario la instaló y arrancó |
| `esim.balance_low` | La wallet cruzó **$5** (umbral fijo, una sola vez) |
| `esim.balance_depleted` | La wallet llegó a $0 y la red cortó |
| `esim.defunded` | Se devolvió el saldo (`returned_usd`) |
| `esim.data_suspended`, `esim.data_resumed`, `esim.terminated` | Cambios de estado |
| `balance.low`, `balance.depleted`, `balance.topped_up`, `balance.auto_refill_succeeded`, `balance.auto_refill_failed` | Saldo de la cuenta reseller |
| `group.*`, `esim.group_assigned`, `esim.group_removed` | Grupos de saldo compartido |

## Detalles que rompen integraciones

1. **Retraso de reporte de ~10 a 15 min.** `fund` responde al instante y el usuario ya puede usar datos. Pero `total_data_charged_usd` y los eventos de saldo se pausan ~15 min después de cada fund. El consumo igual se cuenta y aparece en el siguiente ciclo.
2. **`wallet_balance_usd` se redondea hacia abajo**, hasta ~5¢ por debajo del saldo real. Fondear $20 muestra $19.99. Montos como $9, $18 y $27 dan exacto.
3. **No hay endpoint de consumo en bytes.** El consumo llega solo en USD. Pasar a bytes exige dividir por la tarifa del operador de `/rates` y es aproximado. Esto afecta la reconciliación entre bytes del gateway propio y el uso del carrier.
4. **`defund` es asíncrono.** Devuelve 202, pausa los datos y acredita en ~15 min a la **cuenta reseller**, no al usuario final. Durante ese tiempo no se puede fondear ni reactivar la SIM. El monto final puede ser menor a `estimated_return_usd` si hubo consumo. La devolución al usuario se resuelve del lado de Stellar.
5. **`terminate` es irreversible y pierde el saldo restante.** Hacer `defund` antes.
6. **Los grupos no sirven para facturar por usuario.** Una SIM en un grupo no tiene wallet propia (`wallet_balance_usd` y `total_data_charged_usd` vienen `null`). Usar una eSIM standalone por usuario.
7. **`esim.balance_low` es fijo en $5** y no configurable. Con el retraso de 10 a 15 min, la política de recarga necesita colchón.

## Mapeo a `ConnectivityProvider`

| Método de la interfaz | Citrus |
|---|---|
| `provisionEsim` | `POST /esim/provision` |
| `topUp` | `POST /esim/{iccid}/fund` |
| `getUsage` / `getBalance` | `GET /esim/{iccid}` (`total_data_charged_usd`, `wallet_balance_usd`) |
| `suspend` / `resume` | `disable` / `enable` |
| `refundUnused` | `defund` |
| `terminate` | `terminate` |
| Corte por saldo | evento `esim.balance_depleted` |

Flujo: el gateway mide bytes, el billing los pasa a precio, el voucher sube en Stellar y el operador fondea la SIM en tramos por adelantado. El flotante lo cubre el saldo de la cuenta reseller.

## Sin verificar

- La partner page promete sandbox, pero el OpenAPI solo lista el servidor de producción. Cada provisión ahí cuesta $1.75 reales. Confirmar en el dashboard cómo se accede al sandbox antes de correr tests.
- Las páginas de Citrus dicen "200+" y "220" destinos de forma inconsistente.
- No se comparó el precio contra Telnyx.
- No hay SLA ni detalle de cobertura por país fuera de `/rates`. Proveedor nuevo: chequear `/rates` para los países necesarios.