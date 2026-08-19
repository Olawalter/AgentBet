/**
 * Dump the full on-chain state of one market: terms, totals, resolution record
 * and every fetched evidence row.
 *
 * Run:  npm run state -- <market_id>
 */

import { read, sep } from "./genlayer.js";

const j = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  const mid = process.argv[2] ?? "0";

  sep(`MARKET ${mid}`);
  const m: any = await read("get_market", [mid]);
  console.log(j(m));

  sep("RESOLUTION RECORD");
  const r: any = await read("get_resolution", [mid]);
  if (!r.exists) {
    console.log("  not resolved yet");
  } else {
    console.log("  outcome    :", r.outcome);
    console.log("  sufficient :", r.sufficient);
    console.log("  observed   :", r.observed_summary);
    console.log("  reason     :", r.reason);
    console.log("  rows:");
    for (const row of r.rows) {
      console.log(`   - ${row.readable ? "READ  " : "FAILED"} ${row.url}`);
      console.log(`       observed: ${row.observed || "(none)"}`);
      console.log(`       digest  : ${row.digest.slice(0, 24)}...`);
    }
  }
}

main().catch((e) => {
  console.error("read failed:", e?.message ?? e);
  process.exit(1);
});
