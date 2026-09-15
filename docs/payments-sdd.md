# SDD — Componente de pagos

Documento de ejecución. Verificado contra la documentación oficial de Stellar; lo que es decisión nuestra está marcado como tal.

**El gateway de conectividad y el medidor los construye otra persona.** Este componente cobra.

---

## 1. Decisión de producto que manda sobre el diseño

**Lo que el usuario no consume, vuelve.** Y no lo programamos nosotros: es cómo funciona un canal de pago. El usuario deposita, firma vales por lo que consume, y al cerrar el canal el remanente vuelve solo.

Eso convierte la promesa comercial en una propiedad del sistema. Es la razón principal por la que elegimos canal sobre pagos sueltos.

**La línea del producto:** depositás lo que quieras, pagás solo lo que consumís, lo que sobra vuelve solo.

## 2. Estrategia: tres escalones, no una apuesta

Cada escalón es un punto de salida válido para el Demo Day. **No se empieza el siguiente hasta cerrar el anterior.**

| Escalón | Qué es | Cuándo | Si se cae |
|---|---|---|---|
| **1. Cobro puntual** | Una transferencia on-chain por cobro | Jue 17 | No hay proyecto |
| **2. Sesión / canal** | Depósito único + vales acumulativos | Lun 22 | Se demuestra con el 1 |
| **3. x402** | Compatibilidad con el estándar de Coinbase | Si sobra | Se menciona, no se construye |

## 3. Cómo funciona el canal

El SDK oficial es `@stellar/mpp`. La modalidad de sesión es un **contrato de canal unidireccional en Soroban**: el que paga deposita una vez y después hace muchos pagos fuera de la cadena firmando compromisos acumulativos. No hay transacción por pago. El servidor liquida cerrando el canal cuando le conviene.

Los montos de los compromisos van en el activo depositado. Depositamos USDC, así que todo se denomina en USDC.

No es experimental: QuickNode lo usa en producción para vender acceso a sus nodos sin cuenta ni claves de API. Hay demo en vivo en `mpp.stellar.buzz`.

**Lo que nos resuelve gratis:**

- **El tope deja de ser una pieza.** No se puede gastar más que el depósito. Elimina la dependencia de la smart account con política de límite, que era el componente más riesgoso.
- **El sobrante vuelve solo.**
- **La frecuencia deja de importar.** Los cobros no tocan la cadena.

## 4. La costura con el medidor — cambió, avisar

Con vales acumulativos, el contrato entre medidor y pagos se simplifica:

**Antes (pagos sueltos):** el gateway otorgaba crédito, lo descontaba, y al agotarse pedía pago para acreditar más. Había que llevar dos contadores y resolver idempotencia.

**Ahora (canal):** un solo contador. El medidor reporta consumo acumulado, el agente firma un vale por el total correspondiente, el gateway verifica que el vale cubre el consumo. **Un vale nuevo reemplaza al anterior**, así que un reintento no cobra dos veces: la idempotencia sale gratis.

**El corte cambia de disparador:** ya no es "se agotó la tanda", es "el agente no pudo firmar un vale que cubra el consumo actual" — sea porque el canal se agotó o porque algo falló.

**Los dos mensajes a acordar antes del miércoles:**
1. Medidor → agente: consumo acumulado del usuario y monto total adeudado.
2. Agente → gateway: vale firmado que cubre hasta ese monto, o el motivo por el que no se pudo.

## 5. Escalón 1 — Cobro puntual (jueves 17)

**Qué es:** cada request dispara una transferencia liquidada on-chain individualmente. Sin canal, sin prefondeo, sin facilitador externo.

**Por qué primero aunque no sea el objetivo:** valida el SDK, las cuentas, la línea de confianza y la lectura del 402. Todo eso es común a los tres escalones. Si algo está mal, se rompe el día 3 y no el día 8.

**Modo a usar: pull con variante patrocinada.** El cliente firma las entradas de autorización y el servidor emite la transacción con su propia cuenta como origen, **así el agente nunca paga comisiones de red**. Existe también un modo push donde el cliente emite y manda el hash firmado; no lo necesitamos.

**Cerrado cuando:** existe un hash visible en el explorador. No antes.

## 6. Escalón 2 — Canal (lunes 22)

**Ciclo:** desafío 402 → depósito → firma de vales → cierre y liquidación.

**Configuración del servidor de canal:** contrato del canal, clave pública de compromisos y clave secreta. Tres variables de entorno y un proceso.

**Mapeo al producto:**

| Momento | Qué pasa |
|---|---|
| Configuración previa al viaje | Se abre y deposita el canal. Transacción on-chain visible |
| Consumo | Vales acumulativos, fuera de cadena |
| Canal agotado | No se firma más, el servicio corta |
| Fin de viaje | Cierre on-chain, el sobrante vuelve |

## 7. Las cuatro preguntas del canal — resolver el día 1

Las respuestas están en la guía de sesión. Media hora de lectura y definen el producto:

1. **¿Quién puede cerrar el canal?** Si solo el servidor, el usuario depende de nosotros para recuperar su plata y se rompe el argumento. Si puede él, es perfecto.
2. **¿Hay plazo o bloqueo?** Cuánto tarda en volver la plata tras el cierre.
3. **¿Qué pasa si nadie cierra?** Tiene que haber salida automática o el saldo queda colgado.
4. **¿Cuánto cuesta abrir un canal?** Si es caro, conviene un canal por usuario reutilizable en vez de uno por viaje.

**Anotar las cuatro respuestas en este documento apenas se sepan.**

### Respuestas (15/09)

Verificadas contra la guía oficial de sesión y el README del contrato `stellar-experimental/one-way-channel`, al que apunta el repo del SDK. La guía oficial solo documenta el camino del servidor; el del funder existe en el contrato.

1. **Cualquiera de los dos puede cerrar.** El servidor (recipient) cierra con `close`, o cobra lo adeudado sin cerrar con `settle`. El usuario (funder) cierra solo, sin depender de nosotros: `close_start` y, cumplido el plazo, `refund`. El argumento del producto se sostiene.
2. **El plazo depende de quién cierra.** Si cierra el servidor, el sobrante vuelve al funder en la misma transacción. Si cierra el funder, espera `refund_waiting_period` ledgers (unos 5 segundos por ledger); el valor lo fija el funder al abrir. Pendiente: elegir el valor para la demo y anotarlo acá.
3. **No hay salida automática, pero sí unilateral.** Si nadie cierra, el saldo queda en el contrato hasta que el funder haga `close_start` + `refund`. Contracara: si el funder completa el `refund` antes de que el servidor cierre, el servidor pierde lo adeudado. El servidor debe hacer `settle` periódico o cerrar apenas detecte un `close_start`.
4. **El costo no está documentado; medirlo el día 1.** El contrato es reutilizable (`top_up` o transferencia directa al contrato), así que "un canal por usuario, recarga por viaje" está soportado sin cambiar el diseño.

### Notas de exploración (15/09)

- **Versiones a fijar:** `@stellar/mpp@0.7.1` (última; exige Node >= 22 y es ESM), `@stellar/stellar-sdk@15.1.0` y `mppx@0.6.29`, exactas. `mppx` es peer obligatorio y faltaba en la lista de paquetes. No usar la última `stellar-sdk` 17.x: el peer declarado por `@stellar/mpp` es `^15.1.0` y una instalación limpia resuelve dos copias del SDK (issue #70 del repo del SDK, cerrado el 04/09 sin cambio de rangos). Después de instalar, `npm ls @stellar/stellar-sdk mppx` no debe mostrar duplicados.
- **El reembolso al cerrar puede fallar en silencio.** `close` usa `try_transfer` para devolver el sobrante. Si el funder perdió la línea de confianza de USDC, el sobrante no vuelve y no hay error. Es el error número uno del punto 9, del lado del que paga.
- **Formato del vale:** mapa XDR con `amount` (acumulado), `channel`, `domain` (`chancmmt`) y `network`, firmado con una clave ed25519 separada de la cuenta Stellar (`COMMITMENT_SECRET` en el cliente, `COMMITMENT_PUBKEY` en el servidor). No hay nonce: el nuevo reemplaza al anterior.
- **El SDK no persiste vales.** Hay que construirlo (punto 11).
- **Variables del servidor de canal:** `CHANNEL_CONTRACT`, `COMMITMENT_PUBKEY`, `MPP_SECRET_KEY`. Cliente: `COMMITMENT_SECRET`, `SIGNER_SECRET`. Cierre: `import { close } from "@stellar/mpp/channel/server"`. Subpaths del paquete: `charge/server`, `charge/client`, `channel/server`, `channel/client`, `env`.
- **Constantes del punto 8:** confirmadas.

## 8. Constantes verificadas

| Qué | Valor |
|---|---|
| Red testnet | `stellar:testnet` |
| Red mainnet | `stellar:pubnet` |
| RPC testnet | `https://soroban-testnet.stellar.org` |
| Emisor USDC testnet | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Contrato SEP-41 USDC testnet | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

## 9. Configuración de cuentas

Cuatro pasos. El tercero es el que se olvida y rompe todo:

1. Generar par de claves: `stellar keys generate --network testnet`
2. Fondear con XLM de prueba desde el Lab.
3. **Crear la línea de confianza de USDC** contra el emisor de testnet. Sin esto la cuenta no puede recibir USDC.
4. Pedir USDC de prueba en el faucet de Circle, eligiendo red Stellar.

**Las dos cuentas necesitan la línea de confianza**, la que cobra y la que paga. Es el error número uno.

La clave del agente va en variable de entorno. Clave caliente de testnet: no se commitea, no se reusa en mainnet.

## 10. Escalón 3 — x402 como respaldo y compatibilidad

Si el SDK de MPP da problemas serios, x402 es la salida: resuelve lo mismo con otro protocolo y tiene guía oficial con servidor y cliente completos.

**Paquetes:** `express dotenv @stellar/stellar-sdk @x402/core @x402/express @x402/fetch @x402/stellar`. Node LTS, proyecto como módulo ES.

**Servidor:** `paymentMiddlewareFromConfig` de `@x402/express`, `HTTPFacilitatorClient` de `@x402/core/server`, `ExactStellarScheme` de `@x402/stellar/exact/server`. Esquema `exact`, precio como cadena tipo `"$0.01"`.

**Cliente headless:** `createEd25519Signer(clavePrivada, red)` de `@x402/stellar` crea un firmante desde una clave privada, según SEP-43. El agente no necesita billetera de navegador.

**Facilitador:** el de Coinbase en `https://www.x402.org/facilitator` no requiere registro y soporta Stellar en testnet con comisiones patrocinadas. Alternativa: OpenZeppelin en `https://channels.openzeppelin.com/x402/testnet`, con clave en `channels.openzeppelin.com/testnet/gen`.

**Trampa documentada:** en testnet hay que reconstruir la transacción firmada con comisión de 1 stroop o el facilitador la rechaza. La guía muestra cómo, preservando los datos de Soroban.

## 11. Patrones a respetar

**Fijar versiones el día 1.** Las librerías de MPP cambiaron entre versiones menores, incluidas validaciones que están en unas y no en otras. Versión exacta en el primer commit, sin tocar hasta después del 26.

**Fallar cerrado, no romper al arrancar.** Si la instancia de pago no está disponible, el servidor no explota al iniciar: devuelve 503 por request. Un servidor que no levanta es una demo perdida; uno que devuelve 503 se diagnostica en diez segundos.

**Persistir cada vale.** Si se pierde el último vale firmado, se pierde lo cobrado desde el anterior. No dejarlos solo en memoria.

## 12. Dos tipos de falla, tratados distinto

- **Falla técnica** → reintentar con espera creciente.
- **Canal agotado** → no reintentar, cortar y avisar. **Esto no es un error: es la demo.**

## 13. Orden de tareas

**Día 1 (mar 16)**
- Leer la guía de sesión completa y responder las cuatro preguntas del punto 7.
- Instalar el servidor MCP de Stellar y las skills para la herramienta de IA.
- Crear las dos cuentas con línea de confianza y saldo de prueba.
- Fijar versiones de los paquetes.
- Acordar con el del gateway los dos mensajes del punto 4.

**Día 2 (mié 17)**
- Servidor de juguete devolviendo 402.
- Cliente pagando una vez, modo pull patrocinado.
- **Hash visible en el explorador. Escalón 1 cerrado.**

**Días 3-4 (jue 18 – vie 19)**
- Cobros repetidos contra consumo simulado.
- Integración con el gateway real.
- Corte cuando no se puede cobrar.

**Días 5-7 (sáb 20 – lun 22)**
- Abrir y depositar canal.
- Vales acumulativos.
- Rechazo por canal agotado.
- Cierre con devolución.

**Día 8 en adelante (mar 23)**
- Pulido, persistencia, y x402 solo si sobra tiempo.

## 14. Plan de verificación

1. Servidor devolviendo 402, sin cliente.
2. Cuentas listas: claves, fondeo, línea de confianza, saldo del faucet.
3. **Un pago suelto con hash en el explorador.** Hito real.
4. Cobros repetidos contra consumo del medidor.
5. Canal abierto, depositado, con vales firmándose.
6. Canal agotado: rechazo limpio.
7. Cierre con devolución del sobrante.

**Si el jueves 17 el paso 3 no está, avisar al equipo ese mismo día.** No el viernes.

## 15. Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Falta la línea de confianza | Alta | Checklist del paso 2 |
| Versiones incompatibles | Alta | Fijar exactas el día 1 |
| El canal no llega a tiempo | Media | Escalón 1 ya funcionando |
| Pérdida del último vale | Media | Persistir cada vale |
| Abrir canal sale caro | Media | Medirlo el día 1; si es alto, canal reutilizable |
| El usuario no puede cerrar el canal solo | Media | Pregunta 1 del punto 7. Cambia el discurso si la respuesta es mala |

## 16. Lo que este componente NO hace

No mide bytes, no administra conectividad, no maneja usuarios, no carga saldo, no dibuja nada. Habla con el gateway por HTTP y emite eventos al backend.

---

## Referencias

- Pagos agénticos: `developers.stellar.org/docs/build/agentic-payments`
- MPP en Stellar: `developers.stellar.org/docs/build/agentic-payments/mpp`
- Guía de cobro puntual: `developers.stellar.org/docs/build/agentic-payments/mpp/charge-guide`
- Guía de sesión: `developers.stellar.org/docs/build/agentic-payments/mpp/channel-guide`
- Demo en vivo: `mpp.stellar.buzz`
- Inicio rápido de x402: `developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide`
- Repo x402 en Stellar: `github.com/stellar/x402-stellar`
- Firma de invocaciones de Soroban: `developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations`
- MCP de Stellar: `raven.stellar.buzz/mcp` · Skills: `skills.stellar.org`
