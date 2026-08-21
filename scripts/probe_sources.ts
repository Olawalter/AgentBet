/**
 * Probe the resolution pipeline ON-CHAIN before any money depends on it.
 *
 * Why this script exists: a nondeterministic source that silently fails looks
 * exactly like a feature that was never built. Two sibling projects shipped a
 * "live clock" that was dead on arrival because nobody ever asked a validator
 * to fetch the sources. Green local tests prove nothing about what validators
 * can reach.
 *
 * preview_resolution runs the real fetch/corroborate/decide pipeline and returns
 * the finding WITHOUT touching state or balances, so this is safe to run against
 * the production contract.
 *
 * Run:  npm run probe
 */

import { signer, read, writeAndSettle, sep, GEN } from "./genlayer.js";

async function main() {
  const owner = signer("OWNER_PK");
  const cfg: any = await read("get_config");

  sep("CONTRACT CONFIG (as deployed)");
  console.log("  price subjects   :", cfg.price_subjects);
  console.log("  settlement delay :", cfg.settlement_delay, "s");
  console.log("  recovery grace   :", cfg.recovery_grace, "s");
  console.log("  price tolerance  :", cfg.price_tolerance_bps, "bps");
  console.log("  markets so far   :", cfg.market_count);

  sep("STEP 1 — create a throwaway market (this also probes the CLOCK)");
  // Reaching this at all proves the consensus clock works from validators:
  // create_market calls _utc_now(), which fails closed if the wall-clock hosts,
  // the chain floor or the beacon ceiling cannot be reconciled.
  const before = Number((await read("get_config") as any).market_count);
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec + 900;
  await writeAndSettle(
    owner, "create_market (probe)", "create_market",
    [
      "PROBE — was BTC/USD at or above $1 at the observation instant?",
      "Throwaway market used to probe live feed reachability from validators.",
      "SPOT_THRESHOLD", "BTC/USD", ">=", 100,
      "BTC/USD >= 1.00 observed at the predetermined instant (resolution_start)",
      start, start + 3600, [],
    ],
    0n,
    async () => Number((await read("get_config") as any).market_count) > before,
  );
  const mid = String(before);
  console.log("  probe market id:", mid);

  sep("STEP 2 — run the REAL pipeline against live sources (no state change)");
  console.log("  calling preview_resolution — validators fetch each feed now...");
  const hash = await writeAndSettle(
    owner, "preview_resolution", "preview_resolution", [mid], 0n,
    async () => true,   // read-only by design; settle on the receipt
    600_000,
  );

  // The finding comes back as the transaction's return value.
  const receipt: any = await (owner as any).getTransaction({ hash }).catch(() => null);
  const returned =
    receipt?.tx_data_decoded?.result ??
    receipt?.result?.payload?.readable ??
    receipt?.data?.returnValue ??
    null;

  if (returned) {
    console.log("\n  raw finding:", String(returned).slice(0, 900));
  } else {
    console.log("\n  (receipt did not surface the return value directly —");
    console.log("   resolve the market below to see the recorded rows instead)");
  }

  sep("STEP 3 — resolve the probe market and read the RECORDED evidence");
  const m: any = await read("get_market", [mid]);
  console.log("  bound sources:");
  for (const u of m.resolution_sources) console.log("   -", u);
  console.log("\n  (observation instant / staking close:", m.resolution_start, "— resolve between it and the deadline)");
  console.log("  run:  AGENTBET_ADDRESS=... npm run state --", mid);
}

main().catch((e) => {
  console.error("probe failed:", e?.message ?? e);
  process.exit(1);
});
