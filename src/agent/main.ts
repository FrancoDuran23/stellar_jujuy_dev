// Agent entrypoint (`npm run agent`; T3.3, T8.2). Stage 1's agent is a
// headless CLI, not a long-running server: it performs exactly one paid
// request against the payment server and prints the settlement evidence a
// human pastes into docs/payments-sdd.md §14.3 (S1-R4, S1-R7). WU5's
// `POST /vouchers` will turn this into a real long-running process; until
// then there is nothing for a server loop to do here.

import "dotenv/config";
import { parseAgentEnv } from "../config/env.ts";
import { createMppChargeClient, runOneShotPurchase } from "./charge-client.ts";

const DEFAULT_RESOURCE_PATH = "/paid-resource";

async function main(): Promise<void> {
  const parsed = parseAgentEnv(process.env);
  if (!parsed.ok) {
    console.error(
      JSON.stringify({ level: "error", msg: "invalid agent configuration", detail: parsed.detail }),
    );
    process.exitCode = 1;
    return;
  }

  const url = new URL(DEFAULT_RESOURCE_PATH, parsed.value.PAYMENT_SERVER_URL).toString();
  const port = createMppChargeClient(parsed.value.SIGNER_SECRET);

  try {
    const receipt = await runOneShotPurchase(port, url);
    console.log(
      JSON.stringify({
        level: "info",
        msg: "stage 1 purchase settled",
        txHash: receipt.txHash,
        explorerUrl: receipt.explorerUrl,
        network: receipt.network,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "stage 1 purchase failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

void main();
