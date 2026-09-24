# Integración con Telnyx Wireless (eSIM)

> **Actualización 24/9/2026:** la medición con un gateway propio (WireGuard)
> quedó reemplazada: el consumo se lee del proveedor de eSIM y el proveedor
> elegido para producción es Citrus Mobile. Ver la decisión en el
> [README](../README.md#decisión-medir-con-el-proveedor-sin-gateway-propio).
> El resto de este doc sigue valiendo para `TelnyxProvider`.

Doc dirigido a quien trabaja en el gateway/medidor y NO va a tocar Telnyx,
pero necesita entender qué llega al sistema, por qué, y qué se espera de su
código. Si solo leés una sección, que sea la 1 y la 9.

Código de referencia de esta integración:

- `src/providers/connectivity/ConnectivityProvider.ts` — la interfaz común.
- `src/providers/connectivity/TelnyxProvider.ts` — la implementación contra Telnyx.
- `src/services/PolicyEnforcer.ts` — decisiones de corte/límite según el canal.
- `src/jobs/reconciliation.ts` — reconciliación de consumo (nunca factura).

---

## 1. Rol de Telnyx en la arquitectura completa

Telnyx es **solo el proveedor del SIM**: compra la eSIM, la habilita/deshabilita
y le pone un tope de datos. **No es la fuente de verdad del consumo.** El que
mide los bytes REALES que navegó el usuario es nuestro propio gateway
(WireGuard). Esto no es una decisión nuestra: los contadores de Telnyx
actualizan por ciclos de facturación del carrier, con latencia, y no son aptos
para facturar.

```
  Usuario (teléfono, roaming)
        │  (perfil eSIM instalado con QR)
        ▼
   [Red móvil] ──usuario navega──► [carrier / Telnyx]       ← provisiona, corta a tope
        │
        └────────────── túnel WireGuard ──► [GATEWAY propio]  ← MIDE bytes reales (fuente de verdad)
                                                  │
                                meteredBytes por sesión
                                                  │
                                                  ▼
                          [Backend: PolicyEnforcer]
                                │ compara contra saldo del canal Stellar
                                │  • ajusta data_limit en Telnyx
                                │  • deshabilita SIM si el saldo llegó a 0
                                │  • job de reconciliación loguea la diferencia (solo log)
                                ▼
                    [Componente de pagos / agente Stellar]
                     (POST /vouchers con cumulativeBytes)
```

En concreto, Telnyx tiene 3 únicos trabajos en nuestro flujo:

1. **Provisionar**: comprar la eSIM del viaje y dar el código de activación (QR).
2. **Aplicar cortes**: bajar el `data_limit` a medida que el usuario gasta su
   saldo en USDC, y deshabilitar la SIM cuando el saldo se agota.
3. **Reconciliar**: reportar cuántos MB "dice" Telnyx que consumió la SIM, para
   comparar contra nuestro contador y detectar diferencias. Esa diferencia es
   **esperada** (los carriers miden distinto), se loguea, nunca se factura.

Regla de oro que repetimos en todo el código y en esta doc:

> **Facturamos solo con los bytes del gateway.** Los MB de Telnyx son solo para
> reconciliación.

Por eso el provider (`getUsage`) devuelve MB crudos y la conversión a bytes se
hace explícita en el job de reconciliación, nunca escondida en el provider.

---

## 2. Autenticación

Una sola API key cubre **toda** la cuenta de Telnyx. No hay key por SIM, no hay
key por usuario: lo que identifica a cada SIM es su `simCardId` (UUID), que
Telnyx devuelve al comprarla (config es el nivel `id`, volatil; el `iccid` es
el identificador grabado en el chip, fuera de línea).

- Cómo se genera: `portal.telnyx.com` → API Keys → crear key V2.
- Se manda en cada request como header HTTP:

```
Authorization: Bearer sk-xxxxxxxx
```

- **No hay ambiente de pruebas (sandbox).** Telnyx solo tiene producción. Por
  eso el sistema arranca SIEMPRE contra la API real y todo costo sale de la
  tarjeta cargada en la cuenta (cierre correcto en los endpoints de origen y
  volumen mínimo de pruebas: el `data_limit` a nivel de grupo es la primera
  defensa, ver sección 6).
- En `.env` no va nunca una key real. El código lanza un error claro si
  `TELNYX_API_KEY` / `TELNYX_SIM_GROUP_ID` no están seteadas:

```
Falta TELNYX_API_KEY — generala en portal.telnyx.com y agregala al .env antes de
correr esto contra la API real.
```

---

## 3. Modelo de recursos

Tres recursos, todos vía API v2:

### SIM Card
La entidad de conectividad. Un perfil eSIM (o un SIM físico) una vez
registrado. Tiene `id`, `iccid`, `status`, `data_limit` (tope individual),
`current_billing_period_consumed_data` (cuánto consumió en el ciclo actual) y
`sim_card_group_id`. Es **lo único que nos interesa** para el producto: lo que
compramos con Telnyx y habilitamos/deshabilitamos.

### SIM Card Group
Agrupación de SIMs a la que se le aplica configuración en bloque. Para nosotros
es el **freno de seguridad**: un `data_limit` a nivel de grupo que actúa como
techo máximo absoluto de cada SIM (si una SIM lo supera, Telnyx la corta
sola — `data_limit_exceeded`). Antes de cualquier prueba con tarjeta real, este
límite debe estar puesto, para que un bug de nuestro código jamás genere una
factura gigante. Es el primer item de configuración, no una optimización.

### SIM Card Action
Telnyx no cambia estados al instante: `enable`/`disable`/`standby` son
**asíncronos**. Al pedirlos devuelven `202` con un `id` de acción, y después
hay que hacer polling del estado (`in-progress` → `completed`/`failed`). El
provider lo resuelve con `waitForAction(actionId)` (polling cada 2s, timeout
60s) para que el resto del sistema vea operaciones síncronas.

---

## 4. Ciclo de vida de una SIM

Estados que devuelve `GET /sim_cards/{id}` en `status.value`:

| Estado | Qué significa para el usuario |
|---|---|
| `registering` | La eSIM se está registrando en Telnyx (recién comprada). |
| `enabled` | Lista: puede navegar. Estado objetivo del viaje. |
| `disabling` / `setting_standby` | Una acción está en curso (transitorio). |
| `disabled` | Cortada: no pasa tráfico. Fin de sesión o saldo agotado. |
| `data_limit_exceeded` | Pasó el tope (grupo o SIM). Telnyx la cortó sola; se reactiva levantando el límite o cuando resetea el ciclo. |
| `standby` | Apagada pero "fría": no navega (no factura data). |
| `unauthorized_imei` (sistema) | El chip está en un dispositivo no permitido (fuera de alcance MVP). |
| `blocked` / `abolished` (sistema) | Problema de facturación de la cuenta Telnyx. |

Para nuestro producto hay dos "personas" del ciclo:

- **Inicio de sesión**: compra de la eSIM, se habilita, se le baja el
  `data_limit` a lo que el depósito USDC alcanza a pagar.
- **Fin de sesión**: se deshabilita la SIM → cae a `disabled` (0,20 USD/mes en
  lugar de 2 USD activa). El sobrante del canal Stellar vuelve aparte, por el
  circuito cripto (sección 10).

Transición clave: **cuando el enforcer baja el `data_limit`** la SIM NO se
corta en el momento — el corte real (y gratis para nosotros) lo hace Telnyx en
cuanto la SIM consume arriba del nuevo tope (`data_limit_exceeded`).

---

## 5. Endpoints usados

Base: `https://api.telnyx.com/v2`. Header `Authorization: Bearer <key>` en
todos. Código: `TelnyxProvider.ts`.

Mapa de endpoint → método del provider (el único lugar donde Telnyx se usa):

| # | Endpoint Telnyx | Método en `TelnyxProvider` | Para qué lo usamos |
|---|---|---|---|
| 5.1 | `POST /actions/purchase/esims` | `purchaseEsim(userId)` | comprar la eSIM del viaje |
| 5.2 | `GET /sim_cards/{id}/activation_code` | `fetchActivationCode()` (privado, llama `purchaseEsim`) | QR de instalación del perfil |
| 5.3 | `POST /sim_cards/{id}/actions/enable` | `enable(simCardId)` | habilitar consumo |
| 5.4 | `POST /sim_cards/{id}/actions/disable` | `disable(simCardId)` | corte de datos |
| 5.5 | `GET /sim_card_actions/{id}` | `waitForAction()` (privado, polling de enable/disable) | esperar el fin de una acción asíncrona |
| 5.6 | `PATCH /sim_cards/{id}` | `setDataLimit(simCardId, mb)` | bajar el techo a medida que gasta |
| 5.7 | `GET /sim_cards/{id}` | `getUsage(simCardId)` | consumo reportado para reconciliación |

### 5.1 Comprar eSIM — `POST /actions/purchase/esims`

Para qué: provisiona la eSIM del viaje del usuario (el backend la compra en
paralelo con la apertura del canal Stellar). Compra **una** por sesión: un
perfil eSIM queda atado al dispositivo que lo instaló, no se reutiliza.
`sim_card_group_id` la mete en nuestro grupo (con su tope de seguridad).
`tags` deja el `userId` para auditar.

Request:

```json
{
  "amount": 1,
  "sim_card_group_id": "6a09cdc3-8948-47f0-aa62-74ac943d6c58",
  "status": "enabled",
  "tags": ["user-123"]
}
```

Response `202`:

```json
{
  "data": [
    {
      "id": "6a09cdc3-8948-47f0-aa62-74ac943d6c58",
      "iccid": "89310410106543789301",
      "status": { "value": "enabled" }
    }
  ]
}
```

`id` (del array) es el `simCardId`. `iccid` es el identificador del chip (lo
guardamos para reconciliación y soporte).

El **código de activación (QR)** no viene bien tipado en la compra; lo pedimos
después por SIM:

### 5.2 Código de activación — `GET /sim_cards/{id}/activation_code`

Para qué: genera el QR / código (`LPA:1$...`) que el frontend le muestra al
usuario para escanear una única vez. Solo válido antes de instalar (de uso
único; si el teléfono pierde el perfil hay que comprar otra eSIM).

Response `200`:

```json
{
  "data": {
    "activation_code": "LPA:1$telnyx..."
  }
}
```

### 5.3 Habilitar — `POST /sim_cards/{id}/actions/enable`

Para qué: activa la SIM para consumo. Asíncrono: responde `202` con una acción;
el provider espera con `waitForAction`.

Response `202`:

```json
{
  "data": {
    "id": "8a9b4a35-...",
    "action_type": "enable",
    "status": { "value": "in-progress" }
  }
}
```

### 5.4 Deshabilitar — `POST /sim_cards/{id}/actions/disable`

Para qué: corta la SIM (fin de sesión, o saldo agotado). Mismo patrón 202 +
acción asíncrona.

### 5.5 Consultar una acción — `GET /sim_card_actions/{id}`

Para qué: el polling interno de `waitForAction`. Estados: `in-progress`,
`completed`, `failed`, `interrupted`. Si falla/interrumpe lanzamos error con el
`reason` que da Telnyx.

Response `200`:

```json
{
  "data": {
    "id": "8a9b4a35-...",
    "sim_card_id": "6a09cdc3-...",
    "action_type": "disable",
    "status": { "value": "completed", "reason": null }
  }
}
```

### 5.6 Poner tope de datos — `PATCH /sim_cards/{id}`

Para qué: el corazón del enforcer — ir bajando cuánto puede navegar el usuario
a medida que consume su saldo USDC.

Request:

```json
{
  "data_limit": { "amount": "512.0", "unit": "MB" }
}
```

Response `200` con el SIM actualizado. El tope se puede ajustar a nivel grupo
(`PATCH /sim_card_groups/{id}`) pero nosotros lo hacemos **por SIM** porque
cada usuario tiene su propio saldo.

### 5.7 Consultar consumo y estado — `GET /sim_cards/{id}`

Para qué: la única lectura que hacemos de Telnyx en producción, usada por el
job de reconciliación (sección 11).

Response `200` (campos relevantes):

```json
{
  "data": {
    "id": "6a09cdc3-...",
    "iccid": "89310410106543789301",
    "status": { "value": "enabled" },
    "data_limit": { "amount": "512.0", "unit": "MB" },
    "current_billing_period_consumed_data": { "amount": "127.4", "unit": "MB" }
  }
}
```

> **OJO CON LAS UNIDADES (esto es una fuente de bugs):**
> Telnyx reporta el consumo en **MB**, nunca en bytes. `amount` viene como
> string decimal (`"127.4"`) y `unit` casi siempre `"MB"`. Nuestro gateway mide
> en **bytes**. Si se comparan los dos sin conversión, la reconciliación inventa
> diferencias de ~1 000 000×. Por eso:
> - `getUsage()` devuelve el MB tal cual, **sin convertir**;
> - la conversión explícita `mbToBytes()` está en `reconciliation.ts` (1 MB =
>   1 000 000 bytes, convención decimal del carrier);
> - la facturación **nunca** pasa por este dato.
>
> TODO contra la API real: verificar que Telnyx jamás devuelva `unit: "GB"` en
> `current_billing_period_consumed_data` (si lo hace, la conversión debe
> contemplarlo).

---

## 6. Costos

Tarifas de referencia de la cuenta (verificar con la factura real):

| Concepto | Precio |
|---|---|
| Activación eSIM (por unidad, única vez) | USD 0,70 |
| SIM activa (por mes) | USD 2,00 |
| SIM en standby / disabled (por mes) | USD 0,20 |
| Datos (por MB) | desde USD 0,0125 |

Consecuencias operativas:

- **No hay sandbox**: cada prueba con la API real desembolsa plata. El orden de
  defensas es: (1) `data_limit` de seguridad en el grupo Telnyx, (2) enforcer
  bajando el tope por SIM, (3) deshabilitación al agotarse.
- El costo fijo de la eSIM (0,70 USD) **no se le cobra aparte al usuario**:
  la absorbe un leve incremento del precio por MB en USDC (ver sección 10).
- Poner una SIM en `disabled`/`standby` la baja de 2,00 a 0,20 USD/mes: por eso
  el fin de sesión deshabilita siempre.

---

## 7. Cobertura

- 650+ redes, 180+ países (provisión donde el usuario esté en roaming).
- Selección automática de red por **multi-IMSI**: el chip usa el perfil IMSI
  del país en el que se encuentra, sin que el usuario configure nada.
- Por eso el mismo flujo de compra aplica sin importar el destino del viaje.

---

## 8. Configuración del dispositivo y diagnóstico

Para quien testee con un teléfono real:

- **APN**: `data00.telnyx` (si el perfil no lo setea solo, hay que cargarlo).
- **Roaming obligatorio**: si el usuario está fuera de la red del operador que
  presta el IMSI, sin roaming no conecta.
- **Primer attach**: puede tardar hasta 30 minutos (búsqueda de red del IMSI).
  No dañar lo que funciona: no reinstalar el perfil salvo evidencia.
- Si no conecta, en orden: 1) APN correcto, 2) roaming ON, 3) modo avión
  on/off (re-attach), 4) revisar en la cuenta que la SIM esté `enabled` y con
  `data_limit` > 0, 5) reinstalar perfil (solo si lo anterior falló).

---

## 9. Contrato interno entre el gateway y este módulo

El gateway **no llama a Telnyx**. Nunca. Lo único que el gateway le
provee al sistema es la medición real de bytes; el backend la combina con el
canal y ejecuta Telnyx por detras.

Contrato de entrada (lo que espera este módulo del gateway):

- Por cada sesión de usuario, el gateway manda el **consumo acumulado en bytes**
  (`cumulativeBytes`) más un `sessionId`, `cumulativeAmount` (monto que
  adeuda según el precio por MB) y `meterReadingId` para idempotencia.
- Eso alimenta dos cosas:
  1. `ConnectivitySession.meteredBytes` (bigint) → fuente de verdad del
     enforcer y de facturación.
  2. `POST /vouchers` del agente de pagos (`src/agent/routes/vouchers.ts`) →
     firma el vale que cubre ese consumo.

El formato exacto del mensaje al agente vive en `src/shared/messages.ts`
(`Message1`), y es el que documentan los hooks de `POST /vouchers`. Si el
gateway necesita un endpoint HTTP propio en este módulo, se arma encima de
estos campos (TODO: definir el route del módulo de conectividad cuando el
compañero integre).

Qué NO tiene que hacer el gateway:

- Llamar a Telnyx (autenticación y estados son internos).
- Convertir MB → bytes ni mirar `carrierBytes` para decidir cortes.
- Facturar: el corte y los vales los decide el enforcer + el agente.

A cambio, el gateway sí debe cuidar:

- Si el gateway reporta el **mismo** acumulado (reintento) → el agente devuelve
  el vale guardado con `reused: true` (VE-R9): cuenta como firmado y acredita.
  `stale_reading` es para un acumulado **menor** al ya firmado: el gateway
  perdió estado y debe resincronizar; no se acredita. El cliente del medidor
  (`src/meter/voucher-port.ts`) solo reintenta lo que venga con
  `retryable: true`.
- Si responde `channel_exhausted` (el vale supera el depósito) → el servicio
  se corta: la SIM quedará deshabilitada por el enforcer.

---

## 10. Los dos circuitos de dinero (cripto vs. fiat)

Son **dos circuitos separados que nunca se tocan**:

```
  CIRCUITO CRIPTO (por usuario, en USDC/Stellar)
  Usuario deposita USDC en el canal → consume → el canal le descuenta vales
  → lo gastado queda en la wallet Stellar de la empresa → lo sobrante vuelve
  solo a su wallet al cerrar el canal.

  CIRCUITO FIAT (todo el negocio, en USD)
  La empresa le paga a Telnyx con tarjeta, a fin de mes, el total agregado de
  todas las SIMs (activas + MB consumidos de todos los usuarios). No depende
  del consumo de un usuario puntual ni pasa por Stellar.
```

Consecuencias:

- El USDC que gasta el usuario NO se convierte en el USD que se paga a Telnyx
  uno a uno. La cobertura entre ambos (margen, eSIM absorbida, costo fijo por
  SIM) se maneja con el precio por MB en `TELNYX_PRICE_PER_MB_USDC`.
- Nunca intentes hacer equivalencia estricta entre `carrierBytes`/factura de
  Telnyx y `meteredBytes`/USDC: confluyen a nivel de negocio, no de código.

---

## 11. Funcionalidades implementadas (capa de conectividad local)

Todo lo anterior describe Telnyx. Esta sección documenta la **capa de
conectividad** ya escrita sobre esos endpoints, que es lo que toca el resto del
equipo (gateway, usuario, demo). Hoy el flujo completo de arriba a abajo es:
compra → QR → navega (gateway mide) → enforcer decide (limita/deshabilita) →
reconciliación loguea.

Archivos de la capa:

| Archivo | Qué es |
|---|---|
| `src/providers/connectivity/ConnectivityProvider.ts` | la interfaz común que consumen el enforcer y la reconciliación |
| `src/providers/connectivity/TelnyxProvider.ts` | única implementación real (axios, API v2) |
| `src/models/ConnectivitySession.ts` | registro por viaje (SIM ↔ canal Stellar ↔ contadores) |
| `src/services/PolicyEnforcer.ts` | decisiones de corte/límite de datos |
| `src/jobs/reconciliation.ts` | comparación de consumo gateway vs. carrier (solo log) |

### 11.1 `ConnectivityProvider` — la costura

Interfaz de 5 métodos; todo el negocio depende de ella y **nunca** de
`TelnyxProvider` directo (patrón de puertos del repo). Un backend distinto
(por ejemplo un simulador para demo sin key) se conecta implementando la misma
interfaz.

| Método | Entrada | Salida |
|---|---|---|
| `purchaseEsim` | `userId` (para `tags`) | `EsimRecord { simCardId, iccid, activationCode }` |
| `enable` | `simCardId` | resuelve cuando la acción asíncrona termina |
| `disable` | `simCardId` | igual que `enable` |
| `setDataLimit` | `simCardId, mb` | resuelve la Promise al aplicar el tope |
| `getUsage` | `simCardId` | `SimUsage { mb, status }` |

Contrato de unidades (repetido en §5.7): `getUsage` devuelve **MB crudos**; la
conversión a bytes vive en un único lugar (`reconciliation.ts`), para que un
número del carrier jamás se confunda con la facturación.

### 11.2 `TelnyxProvider` — comportamiento

- **Fail-fast de env**: `createTelnyxProvider()` lanza un error claro si faltan
  `TELNYX_API_KEY` o `TELNYX_SIM_GROUP_ID` (§2). El HTTP es un `axios.create`
  con `baseURL` y `Authorization: Bearer` en todas las llamadas.
- **`purchaseEsim`**: hace `POST /actions/purchase/esims` (uno por sesión, en el
  grupo, con `tags:[userId]`) y enseguida pide el código de activación (es de
  uso único, §5.2). Falla ruidoso si no vuelve `id` o si no hay
  `activation_code`.
- **`enable`/`disable`**: las acciones son asíncronas (§5.3-5.5). El provider
  las vuelve síncronas esperando con `waitForAction`: polling de
  `GET /sim_card_actions/{id}` cada **2s** con **timeout 60s** (constantes
  exportadas y reemplazables por opciones). Estados terminales: `completed` (OK),
  `failed`/`interrupted` → lanza `TelnyxActionError` con el `reason` del carrier.
  Si el tiempo se agota → `TelnyxActionTimeoutError`.
- **`setDataLimit`**: valida `mb` no negativo/finito (`RangeError` en caso
  contrario) y hace `PATCH /sim_cards/{id}` con `data_limit: { amount: String(mb),
  unit: "MB" }`.
- **`getUsage`**: `Number(amount)`, o `0` si Telnyx aún no reporta consumo;
  `status` u `"unknown"`. Sin conversión.
- `sleep`/`now` y `httpClient` son **inyectables** (constructor) — es lo que los
  tests usan para simular el polling y el timeout sin acercarse a la red.

### 11.3 `ConnectivitySession` — el registro del viaje

| Campo | Quién lo llena | Significado |
|---|---|---|
| `id`, `userId`, `provider` | alta de sesión | identidad del viaje; `provider` es literal `"telnyx"` (union cerrada) |
| `simCardId`, `iccid` | `purchaseEsim` | a qué SIM de Telnyx corresponde |
| `channelId` | alta de sesión | canal one-way Stellar contra el que gasta |
| `meteredBytes` | **gateway** | bytes del gateway — fuente de verdad de facturación |
| `carrierBytes` | reconciliación | Telnyx convertida a bytes — solo diagnóstico |
| `startedAt` / `endedAt` | alta / fin | duración del viaje; `endedAt` `null` mientras dura |

`createConnectivitySession()` inicializa ambos contadores en `0n` (bigint,
nunca float) y fija `provider: "telnyx"` para que no exista un mix accidental
de backends.

### 11.4 `PolicyEnforcer` — cuándo limitar y cuándo cortar

Corre en un loop cada **5s** (`start(session, intervalMs)` devuelve `stop()`).
La decisión es pura (`decidePolicy`) y está separada del efecto: `runOnce`
decide y después aplica la acción a través del `ConnectivityProvider`.

| Carril | Condición | Acción sobre Telnyx |
|---|---|---|
| sano | `remaining > 20% del depósito` | nada (`noop`) |
| bajo | `remaining ≤ 20% del depósito` | `setDataLimit(payableMb)` |
| agotado | `remaining == 0` o no alcanza ni 1 MB | `disable` |

Fórmulas (todo en bigint, unidades de 1e-7 USDC):

```
costRaw       = ceilDiv(meteredBytes × pricePerMbRaw, BYTES_PER_MB)
remainingRaw  = max(0, balanceRaw − costRaw)
payableMb     = remainingRaw / pricePerMbRaw       // piso
watermarkRaw  = balanceRaw × lowBalanceBps / 10000 // 2000 bps = 20%
```

Puntos de decisión:

- `computeCostRaw` usa `ceilDiv` (el mismo contrato que `shared/money.ts`):
  redondea **al techo**, así el enforcer nunca considera pagado un MB que no lo
  está, y al derivar siempre del total acumulado el error de una sesión queda
  acotado. `BYTES_PER_MB = 1_000_000` (MB **decimal** del carrier, no MiB).
- `payableMb` es el piso: los MB *enteros* que el saldo restante todavía puede
  pagar; ese número es el `data_limit`. Si el piso es 0 → `disable`.
- `pricePerMbRaw` viene de `TELNYX_PRICE_PER_MB_USDC` vía
  `parseNonNegativeIntegerRaw`; sin esa variable el enforcer se niega a crear
  (`RangeError`/error claro) — un precio missing nunca puede pasar por "gratis".
- **Semántica de `getChannelBalance` (resuelta)**: devuelve el **depósito
  acumulado** del canal, no el saldo restante. El adaptador real es
  `createStellarChannelBalanceAdapter` (`src/meter/meter-service.ts`), que lee
  `depositRaw` (getter `deposited()` → registro local de `channel:open`/`top-up`
  → `balance()` on-chain como cota inferior). Como `costRaw` es acumulado desde
  la apertura, `remaining = depósito − costo`, la misma base que el `remaining`
  de M2 del agente. El `balance()` on-chain NO sirve: baja con cada `settle()` y
  restarle el costo acumulado contaría dos veces lo ya cobrado. El port por
  defecto (`STUB_CHANNEL_BALANCE_PORT`) sigue lanzando si nadie inyecta uno.
- Errores dentro del loop se loguean (`policy_enforcement_failed` con `detail`)
  y el siguiente tick sigue: un fallo de red/Telnyx jamás mata el proceso.

### 11.5 `reconciliation` — compara, nunca factura

- `mbToBytes(mb)`: el **único** punto de conversión MB→bytes del sistema,
  `Math.round(mb × 1_000_000)`; rechaza `NaN`/negativos/infinitos.
- `runReconciliation(session, deps)`: lee `getUsage`, escribe
  `session.carrierBytes` y loguea `reconciliation_diff` (gateway − carrier).
  La diferencia es **esperada** (los carriers miden distinto, con latencia) — se
  loguea con un `note` que dice "nunca se factura".
- **No lanza jamás**: si `getUsage` falla, loguea `warn` y deja `carrierBytes`
  sin tocar (mismo contrato que el `close-monitor` del repo).
- `startReconciliationLoop(session, deps)` la corre cada **60s** y devuelve
  `stop()`.

### 11.6 Variables de entorno nuevas

| Variable | Obligatoria | Uso | Fuente |
|---|---|---|---|
| `TELNYX_API_KEY` | sí | auth de toda la API (Bearer) | portal.telnyx.com → API Keys |
| `TELNYX_SIM_GROUP_ID` | sí | grupo al que ingresa cada SIM comprada | portal.telnyx.com o `POST /sim_card_groups` |
| `TELNYX_PRICE_PER_MB_USDC` | sí para el enforcer | precio por MB en raw units (1e-7 USDC) | grid de precios del negocio |

### 11.7 Tests

`npm run check` (tsc) y `npm test` en verde (371/371). Suites nuevas:

- `src/providers/connectivity/TelnyxProvider.test.ts` — fake `HttpClient` que
  registra llamadas; cubre purchase (cuerpo del POST y QR), polling hasta
  `completed`, acción `failed` → `TelnyxActionError`, timeout con reloj fake,
  PATCH de `data_limit`, `getUsage` sin conversión, fallos de red y fail-fast de
  env.
- `src/services/PolicyEnforcer.test.ts` — matriz de las 3 decisiones (sano /
  límite / corte), el punto exacto del watermark, `computeCostRaw` (ceil,
  bigint, precio ≤ 0) y `runOnce` contra un provider fake.
- `src/jobs/reconciliation.test.ts` — `mbToBytes` (decimal, redondeo, rechazo de
  basura) y comportamiento de no-lanza ante fallo del provider.

### 11.8 Pendientes de integración (dónde sigue el trabajo)

1. **Cablear `getChannelBalance`** al componente Stellar: hecho vía
   `createStellarChannelBalanceAdapter` (depósito acumulado, ver §11.4); falta
   inyectarlo en el `PolicyEnforcer` del proceso que arranque los loops.
2. **Alimentar `meteredBytes`** desde el gateway: hoy el factory lo inicializa
   en `0n` y nadie lo actualiza todavía (es el puente que describimos en §9).
3. **Boot de los loops**: `PolicyEnforcer.start()` y
   `startReconciliationLoop()` son módulos sueltos; falta arrancarlos junto con
   `src/agent/main.ts` (o el proceso del módulo de conectividad).
4. **Simulador de SIM** (opcional): un `ConnectivityProvider` falso para demo
   completa sin key de Telnyx (los tests ya usan esa idea con fakes).
5. **Validación en vivo de campos**: los `TODO: confirmar contra la API real`
   del provider (§5), con la key.

---

## 12. Fuera de alcance del MVP

A propósito, y para que nadie pierda tiempo investigándolos:

| Fuera de alcance | Por qué |
|---|---|
| Private Wireless Gateway | Red privada dedicada para IoT corporativo; nuestro caso es eSIM roaming simple. |
| Traffic Policy Profiles | Políticas de red/seguridad por tráfico; el corte lo decide el enforcer + Telnyx `data_limit`. |
| Blocklists (Wireless Blocklist) | Bloqueo de destinos (premier, VoIP); no hace falta en la promesa actual. |
| VoLTE / voice services | Producto es solo datos; voz (`enable_voice`) está fuera. |
| Reutilización de eSIM entre usuarios | Imposible a nivel iOS/Android: el perfil queda atado al dispositivo que lo instaló; comprar una por sesión es la regla, no una restricción nuestra. |

---

## 13. Documentación oficial

- Portal / API keys: https://portal.telnyx.com
- API Reference (SIM Cards, SIM Card Groups, SIM Card Actions):
  https://developers.telnyx.com/api-reference
- SIMs & eSIMs (conceptos): https://developers.telnyx.com/docs/iot-sim/get-started
- Ciclo de vida de SIMs:
  https://developers.telnyx.com/docs/iot-sim/sim-lifecycle
- SIM Card Groups y data limits:
  https://developers.telnyx.com/docs/iot-sim/sim-card-groups
- Guía de activación eSIM por QR:
  https://support.telnyx.com/en/articles/8117401-how-to-setup-a-telnyx-esim-via-qr-code

Nota de integridad: los nombres de campo marcados con `TODO:` en el código y
en la sección 5 son los pendientes de confirmar contra la API real cuando
tengamos la key (ver la lista completa en la sección 11.8).