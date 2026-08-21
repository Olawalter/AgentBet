/**
 * Definitive probe for the instant-bound observation: create a market whose
 * observation instant arrives shortly, wait until candles for it EXIST, then
 * run preview_resolution twice a few minutes apart. Proves, on-chain:
 *   1. validators can reach the historical endpoints at all;
 *   2. the observation is the price at the bound instant;
 *   3. calling later does not change the observation (same instant, same price).
 *
 * Run:  npx tsx scripts/probe_instant.ts
 */

import { signer, read, writeAndSettle, sep, sleep, STUDIO_URL } from "./genlayer.js";

async function preview(client: any, mid: string): Promise<any> {
  const hash = await writeAndSettle(client, "preview_resolution",
    "preview_resolution", [mid], 0n, async () => true, 600_000);
  await sleep(8_000);
  const r = await fetch(STUDIO_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }),
  }).then((x) => x.json());
  const lr = r.result?.consensus_data?.leader_receipt;
  const leader = Array.isArray(lr) ? lr[0] : lr;
  const b64 = Object.values(leader?.eq_outputs ?? {})[0] as string | undefined;
  if (!b64) return null;
  const s = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(s.slice(s.indexOf("{")));
}

function show(tag: string, j: any) {
  console.log(`\n[${tag}] outcome=${j.outcome} sufficient=${j.sufficient} observed_at=${j.observed_at}`);
  console.log(`  reason: ${j.reason}`);
  for (const row of j.rows) {
    console.log(`   ${row.readable ? "FETCHED " : "UNREACH "}${(row.observed || "-").padEnd(11)} ${row.url.slice(0, 78)}`);
  }
}

async function main() {
  const owner = signer("OWNER_PK");

  sep("create probe market (instant arrives in ~130s)");
  const before = Number((await read("get_config") as any).market_count);
  const start = Math.floor(Date.now() / 1000) + 130;
  await writeAndSettle(owner, "create_market", "create_market", [
    "PROBE instant-bound observation",
    "probe", "SPOT_THRESHOLD", "BTC/USD", ">=", 100,
    "BTC/USD >= 1.00 at the bound instant",
    start, start + 3600, [],
  ], 0n, async () => Number((await read("get_config") as any).market_count) > before);
  const mid = String(before);
  console.log("  market:", mid, "| bound instant:", start);

  const wait1 = start + 240 - Math.floor(Date.now() / 1000);
  sep(`waiting ${wait1}s for candles at the instant to exist`);
  await sleep(Math.max(0, wait1) * 1000);

  const first = await preview(owner, mid);
  if (first) show("preview #1", first);

  sep("waiting 180s, then previewing again — observation must be identical");
  await sleep(180_000);
  const second = await preview(owner, mid);
  if (second) show("preview #2", second);

  if (first && second) {
    const same = JSON.stringify([first.outcome, first.observed_summary, first.observed_at]) ===
                 JSON.stringify([second.outcome, second.observed_summary, second.observed_at]);
    console.log(`\nRESULT: observations ${same ? "IDENTICAL — instant-bound confirmed" : "DIFFER — NOT instant-bound!"}`);
    const fetched = first.rows.filter((r: any) => r.readable).length;
    console.log(`        reachability ${fetched}/${first.rows.length} from validators`);
    if (!same || fetched < 2) process.exit(1);
  } else {
    console.log("could not decode previews");
    process.exit(1);
  }
}

main().catch((e) => { console.error("probe failed:", e?.message ?? e); process.exit(1); });
