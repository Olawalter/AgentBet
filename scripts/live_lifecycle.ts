/**
 * The whole product, proven against the deployed contract with real value.
 *
 *   create -> stake YES -> stake NO -> close -> resolve (validators fetch live
 *   feeds) -> settlement window -> winner claims -> BALANCE ASSERTED ->
 *   second claim rejected -> loser claim rejected
 *
 * Two assertions matter more than the rest, and they are the ones a
 * happy-path demo usually skips:
 *   1. the winner's WALLET BALANCE rises by exactly the payout — contract state
 *      looking right while no GEN moved is a real, previously observed failure;
 *   2. the second claim moves nothing.
 *
 * This runs in real time: the staking window and the settlement delay are wall
 * clock, so expect roughly 12-15 minutes.
 *
 * Run:  npm run lifecycle
 */

import {
  signer, read, writeAndSettle, expectRevert, balanceOf, sleep, sep, GEN,
} from "./genlayer.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const gen = (wei: bigint) => `${Number(wei) / 1e18} GEN`;

async function main() {
  const owner = signer("OWNER_PK");
  const bettor = signer("BETTOR_PK");
  const ownerAddr = (owner as any).account.address as string;
  const bettorAddr = (bettor as any).account.address as string;

  const STAKE_YES = GEN / 2n;   // 0.5 GEN
  const STAKE_NO = GEN / 4n;    // 0.25 GEN
  const POOL = STAKE_YES + STAKE_NO;

  console.log("AgentBet — live lifecycle proof");
  console.log("  owner (YES) :", ownerAddr);
  console.log("  bettor (NO) :", bettorAddr);
  console.log("  pool        :", gen(POOL));

  const cfg: any = await read("get_config");
  const settlementDelay = Number(cfg.settlement_delay);

  // ── 1. create ───────────────────────────────────────────────────────────
  sep("STEP 1 — create a market (also proves the consensus clock is live)");
  const before = Number(cfg.market_count);
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec + 180;                       // staking open ~3 min
  await writeAndSettle(
    owner, "create_market", "create_market",
    [
      "Will BTC/USD be at or above $1,000 at resolution?",
      "Lifecycle proof market. Settled from four independent exchange feeds " +
      "fetched by validators under consensus.",
      "SPOT_THRESHOLD", "BTC/USD", ">=", 100_000,   // $1,000.00 in cents
      "BTC/USD >= 1000.00 at resolution time",
      start, start + 3600, [],
    ],
    0n,
    async () => Number((await read("get_config") as any).market_count) > before,
  );
  const mid = String(before);
  let m: any = await read("get_market", [mid]);
  check("market is open", m.status === "open");
  check("three instant-bound feeds bound", m.resolution_sources.length === 3,
        m.resolution_sources.length + " sources");
  check("escrow starts empty", m.escrow_total === "0");

  // ── 2. stake ────────────────────────────────────────────────────────────
  sep("STEP 2 — both agents lock real GEN");
  await writeAndSettle(
    owner, `stake YES ${gen(STAKE_YES)}`, "stake", [mid, "YES"], STAKE_YES,
    async () => ((await read("get_market", [mid])) as any).yes_total === STAKE_YES.toString(),
  );
  await writeAndSettle(
    bettor, `stake NO ${gen(STAKE_NO)}`, "stake", [mid, "NO"], STAKE_NO,
    async () => ((await read("get_market", [mid])) as any).no_total === STAKE_NO.toString(),
  );
  m = await read("get_market", [mid]);
  check("escrow holds the whole pool", m.escrow_total === POOL.toString(), gen(BigInt(m.escrow_total)));
  check("two stakers recorded", m.staker_count === 2);

  sep("STEP 2b — staking after the window closes must be refused");
  const waitFor = Math.max(0, start - Math.floor(Date.now() / 1000)) + 20;
  console.log(`  waiting ${waitFor}s for the staking window to close...`);
  await sleep(waitFor * 1000);
  const lateRejected = await expectRevert(
    bettor, "late stake", "stake", [mid, "NO"], GEN / 100n,
    async () => ((await read("get_market", [mid])) as any).no_total === STAKE_NO.toString(),
  );
  check("late stake rejected, totals unchanged", lateRejected);

  // ── 3. resolve ──────────────────────────────────────────────────────────
  sep("STEP 3 — resolution: validators fetch the live feeds and agree");
  console.log("  this is the nondeterministic step; allow a few minutes...");
  await writeAndSettle(
    owner, "resolve_market", "resolve_market", [mid], 0n,
    async () => ((await read("get_market", [mid])) as any).final_outcome !== "",
    900_000,
  );
  m = await read("get_market", [mid]);
  const r: any = await read("get_resolution", [mid]);
  console.log(`\n  outcome    : ${m.final_outcome}`);
  console.log(`  sufficient : ${r.sufficient}`);
  console.log(`  observed   : ${r.observed_summary}`);
  console.log(`  reason     : ${r.reason}`);
  console.log("  evidence recorded by the contract:");
  for (const row of r.rows) {
    console.log(`   - ${row.readable ? "READ  " : "FAILED"} ${row.url}`);
    console.log(`       observed ${row.observed || "(none)"}  digest ${String(row.digest).slice(0, 20)}...`);
  }
  check("market finalized", m.status === "finalized", m.status);
  check("outcome is YES (BTC is above $1,000)", m.final_outcome === "YES");
  check("resolution flagged sufficient", r.sufficient === true);
  check("every bound source appears in the record", r.rows.length === 3);
  check("at least two feeds were readable",
        r.rows.filter((x: any) => x.readable).length >= 2,
        r.rows.filter((x: any) => x.readable).length + " readable");

  // ── 4. finality window ──────────────────────────────────────────────────
  sep("STEP 4 — the armed settlement window blocks an early claim");
  const early = await expectRevert(
    owner, "claim before window", "claim_winnings", [mid], 0n,
    async () => ((await read("get_market", [mid])) as any).escrow_remaining === POOL.toString(),
  );
  check("early claim rejected, escrow untouched", early);

  const claimableAt = Number(m.claimable_at);
  const wait2 = Math.max(0, claimableAt - Math.floor(Date.now() / 1000)) + 30;
  console.log(`  waiting ${wait2}s for the ${settlementDelay}s settlement delay...`);
  await sleep(wait2 * 1000);

  // ── 5. claim ────────────────────────────────────────────────────────────
  sep("STEP 5 — winner claims; the WALLET BALANCE must actually move");
  const claimable: any = await read("get_claimable", [mid, ownerAddr]);
  console.log("  contract says claimable:", gen(BigInt(claimable.amount)), `(${claimable.kind})`);
  check("contract offers the whole pool to the sole winner",
        claimable.amount === POOL.toString());

  const balBefore = await balanceOf(ownerAddr);
  await writeAndSettle(
    owner, "claim_winnings", "claim_winnings", [mid], 0n,
    async () => {
      const p: any = await read("get_position", [mid, ownerAddr]);
      return p.claimed === true;
    },
    900_000,
  );
  // The payout is an external message that executes on finalization; give it a
  // moment to land before reading the balance.
  await sleep(20_000);
  const balAfter = await balanceOf(ownerAddr);
  const delta = balAfter - balBefore;

  console.log(`\n  balance before : ${balBefore}`);
  console.log(`  balance after  : ${balAfter}`);
  console.log(`  delta          : ${delta} wei (${gen(delta)})`);
  check("winner's balance rose by exactly the pool", delta === POOL,
        `expected ${POOL}, got ${delta}`);

  m = await read("get_market", [mid]);
  check("escrow fully released", m.escrow_remaining === "0");
  check("market settled", m.status === "settled", m.status);
  const pos: any = await read("get_position", [mid, ownerAddr]);
  check("position marked claimed", pos.claimed === true);
  check("recorded payout equals the pool", pos.payout === POOL.toString());

  // ── 6. double spend ─────────────────────────────────────────────────────
  sep("STEP 6 — a second claim must move nothing");
  const balBeforeSecond = await balanceOf(ownerAddr);
  const second = await expectRevert(
    owner, "second claim", "claim_winnings", [mid], 0n,
    async () => ((await read("get_market", [mid])) as any).escrow_remaining === "0",
  );
  await sleep(15_000);
  const balAfterSecond = await balanceOf(ownerAddr);
  check("second claim rejected on-chain", second);
  check("no additional value left the contract",
        balAfterSecond === balBeforeSecond,
        `${balBeforeSecond} -> ${balAfterSecond}`);

  sep("STEP 7 — the losing position cannot claim");
  const loser = await expectRevert(
    bettor, "loser claim", "claim_winnings", [mid], 0n,
    async () => ((await read("get_market", [mid])) as any).escrow_remaining === "0",
  );
  check("losing claim rejected", loser);
  const loserView: any = await read("get_claimable", [mid, bettorAddr]);
  check("contract explains the loss rather than erroring",
        loserView.claimable === false && loserView.amount === "0",
        loserView.reason);

  sep("RESULT");
  console.log(`  market   : ${mid}`);
  console.log(`  failures : ${failures}`);
  if (failures > 0) process.exit(1);
  console.log("\n  Full lifecycle proven against the deployed contract.");
}

main().catch((e) => {
  console.error("\nlifecycle failed:", e?.message ?? e);
  process.exit(1);
});
