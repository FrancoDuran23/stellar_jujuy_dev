// Per-role environment validation (design 4.4; spec 3.9, CF-R1, CF-R2, T3.1).
// A single zod schema per role, parsed once — never `process.env` read
// piecemeal elsewhere in the codebase (CF-R1). The caller (`config/boot.ts`,
// T4.1) parses this *inside* its try/catch and turns a failure into
// `{status: "unavailable", reason: "config_invalid", detail}`; this module
// never throws and never exits the process — it only classifies.
//
// CF-R3: no secret ever appears in the failure detail. `detail` below only
// ever lists variable *names* (from zod issue paths), never values.
//
// Deviation applied per orchestrator amendment (recorded in docs/sdd/
// payments-mpp.md §6): the agent schema does NOT include `MPP_SECRET_KEY`.
// That variable is the server-only mppx HMAC challenge-signing secret (Spike
// S3 finding, confirmed against the installed `mppx` source — see
// `agent/charge-client.ts` and `server/charge-service.ts`). With a single
// shared `.env`, defining it under both roles let dotenv's last-key-wins
// silently hand one process the other's value.

import { z } from "zod";
import { NETWORKS } from "../shared/stellar/network.ts";
import {
  isHex64,
  isStellarAccountId,
  isStellarContractId,
  isStellarSecretSeed,
} from "../shared/stellar/keys.ts";

const DEFAULT_USDC_SAC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const DEFAULT_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_EXPLORER_BASE_URL = "https://stellar.expert/explorer/testnet";

const RAW_POSITIVE_INTEGER_RE = /^\d+$/;

/**
 * Raw i128 units as a non-negative-digits string, coerced to `bigint`
 * (AC-R5 — never `Number`, never floating point). `defaultValue` is applied
 * to the *string* before the positivity check and the bigint transform.
 */
function rawPositiveIntegerRaw(defaultValue?: string) {
  const base = z.string().regex(RAW_POSITIVE_INTEGER_RE, "must be a string of digits (raw units)");
  const withDefault = defaultValue === undefined ? base : base.default(defaultValue);
  return withDefault
    // Re-checks the format before calling BigInt(): zod runs every check
    // attached to a schema even after an earlier one fails, so without the
    // regex guard here a value that already failed `.regex()` above (e.g.
    // "0.5") would still reach `BigInt()` and throw a raw SyntaxError
    // instead of a clean validation issue.
    .refine(
      (value) => RAW_POSITIVE_INTEGER_RE.test(value) && BigInt(value) > 0n,
      "must be a positive integer",
    )
    .transform((value) => BigInt(value));
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * Treats an empty string as "unset" before handing the value to an optional
 * schema. dotenv parses a bare `KEY=` line (exactly what `.env.example`
 * ships for every stage-2-only variable) as `""`, not `undefined` — and
 * zod's `.optional()` only ever accepts `undefined`, so a schema like
 * `z.string().refine(...).optional()` rejects that `""` as a validation
 * failure instead of treating the variable as not provided. Wrap every
 * optional stage-2 field with this helper so a placeholder `KEY=` left in
 * `.env` behaves the same as omitting the line entirely.
 */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

/**
 * Variables read identically by both processes (design 4.4). Defined once —
 * `PRICE_PER_MIB_RAW` and `CHANNEL_CONTRACT` used to also appear inside the
 * per-role tables and `.env.example`, which is exactly the duplication that
 * let dotenv silently desync the two processes (review finding, Lote B).
 */
const sharedSchema = z.object({
  STELLAR_NETWORK: z.enum(NETWORKS).default("stellar:testnet"),
  SOROBAN_RPC_URL: z.url().default(DEFAULT_SOROBAN_RPC_URL),
  USDC_SAC_CONTRACT: z
    .string()
    .refine(isStellarContractId, "must be a 56-char Soroban contract id starting with C")
    .default(DEFAULT_USDC_SAC_CONTRACT),
  // Required in stage 2, unused in stage 1 — optional here, format-checked
  // when present. A later work unit (WU6) enforces "required once the
  // process operates in stage 2 mode".
  CHANNEL_CONTRACT: emptyToUndefined(
    z
      .string()
      .refine(isStellarContractId, "must be a 56-char Soroban contract id starting with C")
      .optional(),
  ),
  // No default on purpose (design 4.4): an unset price must never be
  // silently treated as free or as an invented fallback.
  PRICE_PER_MIB_RAW: rawPositiveIntegerRaw(),
  DATA_DIR: z.string().min(1).default("./data"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  BACKEND_EVENTS_URL: emptyToUndefined(z.url().optional()),
  EXPLORER_BASE_URL: z.url().default(DEFAULT_EXPLORER_BASE_URL),
});

const serverSchema = sharedSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  STELLAR_RECIPIENT: z.string().refine(isStellarAccountId, "must be a 56-char account id starting with G"),
  // Generic mppx HMAC secret used to bind 402 challenges to their contents —
  // NOT a Stellar keypair (Spike S3, confirmed against the installed mppx
  // source: `Mppx.create({ secretKey })` only checks it is a non-empty
  // string). The spec's original note that it must be "parseable as a
  // Keypair" does not match the real SDK; this schema follows the SDK.
  MPP_SECRET_KEY: z.string().min(1),
  FEE_PAYER_SECRET: z
    .string()
    .refine(isStellarSecretSeed, "must be a 56-char secret seed starting with S"),
  COMMITMENT_PUBKEY: emptyToUndefined(
    z.string().refine(isHex64, "must be exactly 64 hex characters").optional(),
  ),
  FUNDER_ACCOUNT: emptyToUndefined(
    z
      .string()
      .refine(isStellarAccountId, "must be a 56-char account id starting with G")
      .optional(),
  ),
  SETTLE_THRESHOLD_BPS: z.coerce.number().int().min(1).max(10000).default(5000),
  CHANNEL_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  CLOSE_MONITOR_LOOKBACK_LEDGERS: z.coerce.number().int().min(1).default(120),
  CLOSE_ASSERT_ATTEMPTS: z.coerce.number().int().min(1).default(6),
  CLOSE_ASSERT_INTERVAL_MS: z.coerce.number().int().min(1).default(2500),
  INIT_RETRY_INTERVAL_MS: z.coerce.number().int().min(1).default(10000),
  RPC_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1).default(2000),
})
  // Stage-2 gate (WU6/WU7 deviation, documented in docs/sdd/payments-mpp.md
  // §6, Lote E): the design left "stage 2 only" as a comment on individual
  // fields without a single, enforced rule. Presence of `CHANNEL_CONTRACT`
  // is the one stage-2 switch (matches the existing per-field "sí en
  // escalón 2" comments below) — once it is set, the two variables the
  // channel route/close flow cannot function without must be set too, in
  // the SAME single validation point (CF-R1), not re-checked ad hoc later.
  .superRefine((value, ctx) => {
    if (value.CHANNEL_CONTRACT === undefined) return;
    if (value.COMMITMENT_PUBKEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["COMMITMENT_PUBKEY"],
        message: "COMMITMENT_PUBKEY is required once CHANNEL_CONTRACT is set (stage 2)",
      });
    }
    if (value.FUNDER_ACCOUNT === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["FUNDER_ACCOUNT"],
        message: "FUNDER_ACCOUNT is required once CHANNEL_CONTRACT is set (stage 2)",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

const agentSchema = sharedSchema.extend({
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  GATEWAY_TOKEN: z.string().min(1),
  PAYMENT_SERVER_URL: z.url().default("http://127.0.0.1:8080"),
  SIGNER_SECRET: z
    .string()
    .refine(isStellarSecretSeed, "must be a 56-char secret seed starting with S"),
  COMMITMENT_SECRET: emptyToUndefined(
    z.string().refine(isHex64, "must be exactly 64 hex characters").optional(),
  ),
  MAX_DELTA_PER_REQUEST_RAW: rawPositiveIntegerRaw("5000000"),
  METER_REPORT_INTERVAL_MS: z.coerce.number().int().min(1).default(10000),
  // Bounds `depositPort.getDepositRaw`/`signer.sign` while `POST /vouchers`
  // holds the per-channel mutex (review finding, Lote D): neither call may
  // hang the lock indefinitely. See `agent/routes/vouchers.ts`.
  PORT_CALL_TIMEOUT_MS: z.coerce.number().int().min(1).default(10000),
})
  // Same stage-2 gate as serverSchema above, mirrored for the agent's own
  // stage-2-only variable.
  .superRefine((value, ctx) => {
    if (value.CHANNEL_CONTRACT === undefined) return;
    if (value.COMMITMENT_SECRET === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["COMMITMENT_SECRET"],
        message: "COMMITMENT_SECRET is required once CHANNEL_CONTRACT is set (stage 2)",
      });
    }
  });

export type AgentEnv = z.infer<typeof agentSchema>;

export type EnvParseResult<T> = { ok: true; value: T } | { ok: false; detail: string };

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  rawEnv: Record<string, string | undefined>,
): EnvParseResult<T> {
  const result = schema.safeParse(rawEnv);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const variables = [
    ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "(unknown)"))),
  ];
  return {
    ok: false,
    detail: `invalid or missing environment variable(s): ${variables.join(", ")}`,
  };
}

/** Parses and validates the server's environment (CF-R1). Never throws. */
export function parseServerEnv(
  rawEnv: Record<string, string | undefined> = process.env,
): EnvParseResult<ServerEnv> {
  return parseWithSchema(serverSchema, rawEnv);
}

/** Parses and validates the agent's environment (CF-R1). Never throws. */
export function parseAgentEnv(
  rawEnv: Record<string, string | undefined> = process.env,
): EnvParseResult<AgentEnv> {
  return parseWithSchema(agentSchema, rawEnv);
}
