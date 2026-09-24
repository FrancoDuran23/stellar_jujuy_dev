/**
 * Puerto del medidor hacia el agente de pagos: `POST /vouchers` (MPP, canal
 * one-way de Soroban).
 *
 * Es la única costura entre la capa de conectividad/medidor y la capa de
 * pagos (docs/sdd/payments-mpp.md §2.3.3/§2.3.4): un request HTTP con el
 * mensaje 1 (M1), una respuesta con el mensaje 2 (M2). Los schemas y el
 * vocabulario de `reason` NO se duplican acá — se reusan de `src/shared/`
 * (`messages.ts`, `reasons.ts`, `money.ts`, `retry.ts`).
 *
 * Tres piezas:
 * - `createHttpVoucherPort`: un intento contra el agente real (auth con
 *   `X-Gateway-Token`, M1 validado antes de salir, M2 validado al volver).
 * - `withVoucherRetry`: decorador que reintenta SOLO lo reintentable
 *   (`retryable: true` en M2, o una falla de transporte), con el deadline
 *   total acotado por FT-R3. Un `retryable: false` jamás se reintenta.
 * - `createInMemoryVoucherPort`: doble offline que imita las reglas del
 *   agente (idempotencia por monto acumulado, agotamiento contra depósito)
 *   para la demo y los tests, sin red.
 */

import { createHash } from "node:crypto";
import {
  buildUnsigned,
  message1Schema,
  message2Schema,
  message2SignedSchema,
  type Message1,
  type Message2,
} from "../shared/messages.ts";
import { computeExpectedAmountRaw } from "../shared/money.ts";
import { RetryDeadlineExceededError, TimeoutError, withRetry, type RetryOptions } from "../shared/retry.ts";
import type { Network } from "../shared/stellar/network.ts";

/** Puerto que consume `IntegratedMeterService`. Devuelve SIEMPRE un sobre M2
 * válido (firmado o no firmado); cualquier otra cosa (red caída, 401, 400,
 * cuerpo que no es M2) es un `VoucherTransportError`. */
export type VoucherPort = {
  requestVoucher(m1: Message1): Promise<Message2>;
};

/** Falla que NO es un resultado de negocio del agente: transporte, auth
 * (401), schema (400) o una respuesta que no respeta el contrato M2.
 * `retryable` distingue "preguntá de nuevo" (red, 5xx) de "no tiene sentido
 * reintentar" (token mal configurado, M1 inválido). */
export class VoucherTransportError extends Error {
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;

  constructor(detail: string, options: { retryable: boolean; httpStatus?: number }) {
    super(detail);
    this.name = "VoucherTransportError";
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Armado del mensaje 1
// ---------------------------------------------------------------------------

export type MeterReadingInput = {
  sessionId: string;
  /** Contrato del canal one-way (C..., 56 chars) — `CHANNEL_CONTRACT`. */
  channel: string;
  network: Network;
  /** Bytes acumulados desde la apertura del canal (VE-R4), nunca un delta. */
  cumulativeBytes: number;
  /** `PRICE_PER_MIB_RAW` — el MISMO valor que usa el agente (CF-R2). */
  pricePerMibRaw: bigint;
  meterReadingId: string;
  observedAt: Date;
};

/**
 * Arma el M1 de una lectura. `cumulativeAmount` sale de la MISMA función
 * pura que usa el agente para su contraverificación (`computeExpectedAmountRaw`,
 * AC-R2 / S1-R5): el gateway es la autoridad del monto, pero si el precio o
 * la fórmula difieren el agente responde `amount_rejected`.
 */
export function buildMessage1(input: MeterReadingInput): Message1 {
  return {
    version: 1,
    sessionId: input.sessionId,
    channel: input.channel,
    network: input.network,
    asset: "USDC",
    cumulativeBytes: input.cumulativeBytes,
    cumulativeAmount: computeExpectedAmountRaw(BigInt(input.cumulativeBytes), input.pricePerMibRaw).toString(),
    meterReadingId: input.meterReadingId,
    observedAt: input.observedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cliente HTTP real
// ---------------------------------------------------------------------------

/** Tope por request HTTP. Menor que el deadline total para que entren al
 * menos un par de intentos dentro de `METER_REPORT_INTERVAL_MS`. */
export const VOUCHER_REQUEST_TIMEOUT_MS_DEFAULT = 4_000;

export type HttpVoucherPortOptions = {
  /** URL completa del endpoint, ej. `http://127.0.0.1:8081/vouchers`. */
  url: string;
  /** El mismo secreto que el agente lee de `GATEWAY_TOKEN` (VE-R1). */
  gatewayToken: string;
  /** Inyectable para tests. @default globalThis.fetch */
  fetch?: typeof fetch;
  /** @default VOUCHER_REQUEST_TIMEOUT_MS_DEFAULT */
  requestTimeoutMs?: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeErrorBody(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return "sin detalle";
}

/**
 * Un único intento contra `POST /vouchers`. Mapeo de respuestas (FT-R5: el
 * status HTTP solo dice "¿puedo preguntar de nuevo?"):
 * - `200` / `503` con cuerpo M2 válido → se devuelve el M2 tal cual
 *   (firmado, o no firmado con su `retryable` explícito — FT-R1).
 * - `401` (token) / `400` (schema) → `VoucherTransportError` NO reintentable:
 *   es configuración o un bug, reintentar igual daría lo mismo.
 * - otro `5xx`, o `503` sin M2 (proxy) → reintentable.
 * - otro `4xx`, o `200` sin M2 válido → NO reintentable (contrato roto).
 * - error de red / timeout → reintentable.
 */
export function createHttpVoucherPort(options: HttpVoucherPortOptions): VoucherPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? VOUCHER_REQUEST_TIMEOUT_MS_DEFAULT;

  return {
    async requestVoucher(m1) {
      // Validamos el M1 acá con el schema compartido: un M1 inválido es un
      // bug del medidor, mejor detectarlo sin gastar un round-trip (y sin
      // reintentar un 400 seguro).
      const parsedM1 = message1Schema.safeParse(m1);
      if (!parsedM1.success) {
        throw new VoucherTransportError(`M1 inválido: ${parsedM1.error.message}`, { retryable: false });
      }

      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gateway-token": options.gatewayToken,
          },
          body: JSON.stringify(parsedM1.data),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new VoucherTransportError(`POST /vouchers falló en transporte: ${messageOf(error)}`, {
          retryable: true,
        });
      }

      const status = response.status;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      if (status === 200 || status === 503) {
        const parsedM2 = message2Schema.safeParse(body);
        if (parsedM2.success) return parsedM2.data;
        throw new VoucherTransportError(`respuesta HTTP ${status} no es un M2 válido`, {
          retryable: status === 503,
          httpStatus: status,
        });
      }

      if (status === 401) {
        throw new VoucherTransportError(`agente rechazó el token (401): revisar GATEWAY_TOKEN — ${describeErrorBody(body)}`, {
          retryable: false,
          httpStatus: status,
        });
      }
      if (status === 400) {
        throw new VoucherTransportError(`agente rechazó el M1 (400): ${describeErrorBody(body)}`, {
          retryable: false,
          httpStatus: status,
        });
      }
      throw new VoucherTransportError(`respuesta HTTP inesperada ${status} de POST /vouchers`, {
        retryable: status >= 500,
        httpStatus: status,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Reintentos acotados
// ---------------------------------------------------------------------------

/** FT-R3: el tiempo total (intentos + esperas) debe quedar por debajo de
 * `METER_REPORT_INTERVAL_MS` (10s por defecto en el agente). */
export const VOUCHER_RETRY_DEADLINE_MS_DEFAULT = 10_000;

export type VoucherRetryOptions = Omit<RetryOptions, "isRetryable">;

/** Transporta un M2 `retryable: true` a través de `withRetry` (que solo
 * reintenta ante un throw). Interno a este módulo. */
class RetryableEnvelope extends Error {
  readonly envelope: Message2;

  constructor(envelope: Message2) {
    super(envelope.status === "unsigned" ? `${envelope.reason}: ${envelope.detail}` : "retryable");
    this.name = "RetryableEnvelope";
    this.envelope = envelope;
  }
}

function isRetryableVoucherError(error: unknown): boolean {
  return (
    error instanceof RetryableEnvelope ||
    error instanceof TimeoutError ||
    (error instanceof VoucherTransportError && error.retryable)
  );
}

/**
 * Envuelve cualquier `VoucherPort` con `withRetry` (backoff exponencial con
 * jitter, `shared/retry.ts`). Reintenta SOLO:
 * - un M2 no firmado con `retryable: true` (`signer_unavailable`,
 *   `upstream_unavailable`, `internal_error`);
 * - un `VoucherTransportError` reintentable o un `TimeoutError`.
 *
 * Nunca reintenta un M2 firmado ni un `retryable: false` (FT-R1: la rama del
 * gateway es `if (!retryable) cut(); else backoff();`). Si se agotan los
 * intentos con un M2 reintentable, devuelve ese último M2 (el llamador ve el
 * `reason` real, también si lo cortó el deadline); si se agotan con una
 * falla de transporte, relanza.
 */
export function withVoucherRetry(port: VoucherPort, options: VoucherRetryOptions = {}): VoucherPort {
  return {
    async requestVoucher(m1) {
      let lastRetryable: Message2 | undefined;
      try {
        return await withRetry(
          async () => {
            const envelope = await port.requestVoucher(m1);
            if (envelope.status === "unsigned" && envelope.retryable) {
              lastRetryable = envelope;
              throw new RetryableEnvelope(envelope);
            }
            return envelope;
          },
          {
            deadlineMs: VOUCHER_RETRY_DEADLINE_MS_DEFAULT,
            ...options,
            isRetryable: isRetryableVoucherError,
          },
        );
      } catch (error) {
        if (error instanceof RetryableEnvelope) return error.envelope;
        // El deadline cortó antes de otro intento: el último M2 reintentable
        // visto describe mejor la situación que el error del deadline.
        if (error instanceof RetryDeadlineExceededError && lastRetryable !== undefined) return lastRetryable;
        throw error;
      }
    },
  };
}

/** Composición por defecto para producción: HTTP real + reintentos. */
export function createAgentVoucherPort(
  options: HttpVoucherPortOptions & { retry?: VoucherRetryOptions },
): VoucherPort {
  return withVoucherRetry(createHttpVoucherPort(options), options.retry);
}

// ---------------------------------------------------------------------------
// Doble offline (demo / tests)
// ---------------------------------------------------------------------------

export type InMemoryVoucherPortOptions = {
  /** Depósito del canal en raw units (1e-7 USDC). */
  depositRaw: bigint;
  /** Etiqueta para la firma falsa determinística. NO es un secreto. */
  seed?: string;
  now?: () => Date;
};

/**
 * Imita las reglas de negocio de `agent/routes/vouchers.ts` sin red ni
 * disco: igual al mayor firmado → `reused: true`; menor → `stale_reading`;
 * por encima del depósito → `channel_exhausted`; mayor → vale nuevo. La
 * firma es un hash determinístico (como ed25519, RFC 8032), NUNCA una firma
 * real. Los sobres se construyen/validan con los schemas compartidos, así
 * el doble no puede emitir algo que el agente real no emitiría.
 *
 * No recalcula guardrails (AC-R2/AC-R7): eso lo cubren los tests del agente.
 */
export function createInMemoryVoucherPort(options: InMemoryVoucherPortOptions): VoucherPort {
  const seed = options.seed ?? "meter-demo-fake-voucher";
  const now = options.now ?? (() => new Date());
  const commitmentPubkey = createHash("sha256").update(`${seed}:commitment-pubkey`).digest("hex");
  let highest: { amountRaw: bigint; signature: string; signedAt: string } | undefined;

  function signed(m1: Message1, channel: string, reused: boolean): Message2 {
    return message2SignedSchema.parse({
      version: 1,
      status: "signed",
      sessionId: m1.sessionId,
      channel,
      voucher: {
        cumulativeAmount: highest!.amountRaw.toString(),
        signature: highest!.signature,
        commitmentPubkey,
        network: m1.network,
      },
      meterReadingId: m1.meterReadingId,
      reused,
      remaining: clampMin0(options.depositRaw - highest!.amountRaw).toString(),
      signedAt: highest!.signedAt,
    });
  }

  return {
    async requestVoucher(m1) {
      const channel = m1.channel;
      if (channel === undefined) {
        throw new VoucherTransportError("channel es obligatorio en POST /vouchers (VE-R5)", {
          retryable: false,
          httpStatus: 400,
        });
      }
      const amountRaw = BigInt(m1.cumulativeAmount);
      const previousRaw = highest?.amountRaw ?? 0n;

      if (highest !== undefined && amountRaw === highest.amountRaw) {
        return signed(m1, channel, true);
      }
      if (highest !== undefined && amountRaw < highest.amountRaw) {
        return buildUnsigned("stale_reading", {
          sessionId: m1.sessionId,
          channel,
          remaining: clampMin0(options.depositRaw - previousRaw).toString(),
          meterReadingId: m1.meterReadingId,
          detail: `cumulativeAmount ${amountRaw} is lower than the highest signed amount ${highest.amountRaw}`,
        }).body;
      }
      if (amountRaw > options.depositRaw) {
        return buildUnsigned("channel_exhausted", {
          sessionId: m1.sessionId,
          channel,
          remaining: clampMin0(options.depositRaw - previousRaw).toString(),
          meterReadingId: m1.meterReadingId,
          detail: `requested cumulative ${amountRaw} exceeds channel deposit ${options.depositRaw}`,
        }).body;
      }

      const signature = createHash("sha512").update(`${seed}:${m1.network}:${channel}:${amountRaw}`).digest("hex");
      highest = { amountRaw, signature, signedAt: now().toISOString() };
      return signed(m1, channel, false);
    },
  };
}

function clampMin0(value: bigint): bigint {
  return value < 0n ? 0n : value;
}
