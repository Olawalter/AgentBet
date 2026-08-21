# AgentBet — Response: Resolution Bounds, Instant-Bound Observation, Claimability Alignment

Thank you for the review. All three findings are fixed, redeployed, and proven
on-chain — including a live demonstration that the observation can no longer be
moved by choosing when to resolve.

**Contract fix:** [`0828c7c`](https://github.com/Olawalter/AgentBet/commit/0828c7c)
**Application alignment:** [`f9d9ae2`](https://github.com/Olawalter/AgentBet/commit/f9d9ae2) — see [part two](#part-two--the-application-brought-into-line-with-those-rules)
**Redeployed contract:** `0xb37208B984c7Fc56df6c07913cca6d5062f0451A`
(StudioNet · deploy tx `0xc377409adaa24bb1f990018e04dd9d09d9d5128f7d53a2b1e297e7e910bd3546` ·
[explorer](https://explorer-studio.genlayer.com/address/0xb37208B984c7Fc56df6c07913cca6d5062f0451A))

---

## The request

> Please enforce an upper bound for resolution and bind price observations to a
> predetermined instant or historical datum so callers cannot choose a favorable
> live-price moment or race the refund path. Also align claimability with the
> settlement delay and add focused tests for resolution after both deadlines.

Each clause, in turn.

---

## 1. Upper bound for resolution — and the refund race, structurally closed

`resolve_market` was previously legal any time after `resolution_start` with no
upper limit, which created the two problems you named: an indefinitely live
resolution path, and a window where a late resolve could race `mark_unresolved`
over the same escrow.

Now the timeline is three disjoint regimes:

```
resolution_start          resolution_deadline          recovery_deadline
      │                          │                            │
      │   resolve_market legal   │   NEITHER path is live     │  mark_unresolved
      │   [start, deadline]      │   (grace gap — waits)      │  (refund only)
──────┴──────────────────────────┴────────────────────────────┴───────────────►
```

- `resolve_market` reverts once `now > resolution_deadline`
  ("the resolution deadline has passed — this market can only be recovered for
  refunds now (mark_unresolved after the recovery deadline)").
- `mark_unresolved` starts **strictly later** (`now > recovery_deadline`,
  with `recovery_deadline = resolution_deadline + RECOVERY_GRACE`) and only ever
  refunds.
- In the grace gap, neither path is live — the market simply waits.

Because the two paths' legality windows are disjoint by construction, there is
no instant at which both a conclusive resolution and a refund opening are
possible. The race is not narrowed; it is removed.

## 2. Price observations bound to a predetermined instant

This was the deepest change. Previously a price market read the **live spot**
at whatever moment `resolve_market` happened to run — so with a multi-hour
resolution window, whoever called it chose the price. Your "favorable
live-price moment" finding was correct.

Now the observation datum is **fixed at market creation**:

- Every price market observes the price **at `resolution_start`** — the
  observation instant is a term of the market, immutable once created, shown to
  every staker before they commit capital.
- The bound URLs are **fixed at creation with no caller input**: Bitfinex and
  CoinGecko are historical-candle queries with the instant baked into the URL
  itself (`start`/`end`, `from`/`to`); Gemini is a rolling recent-candles
  endpoint, where the instant is enforced by the next layer instead. All three
  were probed reachable from validators on-chain before being trusted.
- The extractors **validate the operators' own candle timestamps** against the
  window `[instant, instant + 300s]`, in contract code — one-sided, so even a
  candle from one second *before* the instant is rejected. A server returning
  data for the wrong period — or a decoy reading from outside the window — is
  not a reading, whichever URL it came from. Corroboration (≥2 operators
  within 1%) and the median comparison then run exactly as before, on the
  instant's data.
- Price-market resolution windows are **capped at 24 hours past the instant**
  (`MAX_PRICE_RESOLUTION_WINDOW = 86400`), so the datum stays within every
  operator's candle retention and the market cannot outlive its own
  observability.

**Proven on-chain, not just in tests** — the moment-shopping experiment
(`scripts/probe_instant.ts`, run against the redeployed contract): one market,
two `preview_resolution` calls **3 minutes apart** while the live BTC price
moved:

```
preview #1 (0xdd6dd124…a9d1): observed 73273.42 at bound instant 1787268608
preview #2 (0xfcd6fb2c…4872): observed 73273.42 at bound instant 1787268608
RESULT: observations IDENTICAL — instant-bound confirmed
```

Same instant, same price, regardless of when the caller shows up. That is the
definition of the fix.

## 3. Claimability aligned with the settlement delay

`get_claimable` previously reported `claimable: true` the moment a market
finalized, while `claim_winnings` correctly refused until
`finalized_at + SETTLEMENT_DELAY` — the view advertised a claim the write path
would reject.

Now the view enforces the same gate. A view cannot run the consensus clock, so
it reads the node's transaction datetime (the write path still re-enforces the
gate independently on the consensus clock — the view is a faithful preview,
the write is the authority):

- during the delay: `kind: "winnings_pending"`, **amount shown, `claimable: false`**,
  with the unlock epoch in `claimable_at`;
- after the delay: `kind: "winnings"`, `claimable: true` — and the write path
  accepts;
- refunds are claimable immediately (there is no adjudication to appeal), so
  that branch consults no clock at all.

The frontend renders these states directly, so a user sees "pending — unlocks
at …" rather than a button that fails.

---

## 4. Focused tests for resolution after both deadlines

14 new tests in
[`tests/direct/test_resolution_bounds.py`](tests/direct/test_resolution_bounds.py),
named for exactly the scenarios you raised:

| Concern | Tests |
|---|---|
| Resolution after the **resolution deadline** | `test_resolve_after_the_resolution_deadline_reverts`, `test_resolve_at_the_last_moment_works` (boundary), `test_resolve_inside_the_window_works` (control) |
| Resolution after the **recovery deadline** | `test_resolve_after_the_recovery_deadline_also_reverts` |
| The refund race | `test_refund_path_cannot_be_preempted_by_a_late_resolve` (the late resolve reverts and both stakes then refund in full, draining escrow to zero), `test_between_the_deadlines_the_market_simply_waits` |
| Moment shopping | `test_caller_timing_cannot_change_the_observation` (two markets resolved at opposite ends of the window report the identical observation — the regression pin; the on-chain probe in §2 is the live proof), `test_observed_at_is_the_bound_instant_not_resolve_time` |
| Datum integrity | `test_a_reading_outside_the_window_is_not_a_reading` (a decoy candle outside `[instant, instant+300s]` is discarded even when only it would satisfy the threshold), `test_source_urls_embed_the_instant_at_creation`, `test_price_market_window_is_capped_at_creation` |
| View/write agreement | `test_view_does_not_advertise_during_the_settlement_delay`, `test_view_and_write_flip_together_after_the_delay` (the view flips claimable in the same breath the write starts accepting), `test_refund_claimability_needs_no_delay` |

Suite total: **122 passing** (`pytest tests/direct -v`). The four new guards —
the deadline check, the candle-timestamp window, the window cap, and the
view-side delay gate — were **mutation-checked**: disabling any one of them in
a scratch copy makes the suite fail.

---

## 5. Live verification on the redeployed contract

Full lifecycle (`npm run lifecycle`, `lifecycle_v3b.log`) — **22 checks, 0 failures**:

| Step | Transaction | Result |
|---|---|---|
| create (instant-bound) | `0x1ad1afe8…5919c53984` | 3 candle sources bound, instant fixed |
| stake YES 0.5 / NO 0.25 | `0x6bcd5881…84e0207cd` / `0x41ab6e85…fd8ad0c064` | escrow 0.75 GEN |
| late stake | `0xdf2fa91a…13277fe0c35b18` | rejected, totals unchanged |
| resolve | `0x10e63b50…f94bb1c656c` | YES from the bound instant's data — 3/3 feeds fetched, 2 corroborated at the instant |
| claim before window | `0x24969087…1fecef48eeaa` | rejected, escrow untouched |
| claim | `0xf4733ed1…cbc061adb9266` | **balance +750000000000000000 wei exactly** |
| second claim | `0x110977b1…dbf578472d69e4a58188` | rejected, balance unchanged |
| loser claim | `0xa43b9c58…5f350b5025f1` | rejected, explained not errored |

Plus the moment-shopping probe above (`probe_instant.log`), which is the direct
on-chain demonstration of finding #2's fix.

---

## Notes for re-review

- The **GitHub default branch carries the fix** (`0828c7c` on `main`); direct
  suite, lint (`genvm-lint check` clean) and the web build all pass on it.
- `docs/security-review.md` §5–6 were updated: the moment-shopping and
  resolve/refund-race rows moved from "known limitations" to "threats closed",
  with the mechanisms above.
- The hosted UI at agentbet-belief.vercel.app may briefly lag the redeploy
  until its `NEXT_PUBLIC_CONTRACT_ADDRESS` is bumped to
  `0xb37208B984c7Fc56df6c07913cca6d5062f0451A`; the contract address above is
  authoritative, and `npm run state -- <id>` reads it directly.
- Event-claim markets already carried no moment-shopping exposure (their
  evidence is cited pages, not a spot price), but they gain the same resolution
  upper bound and race closure, since those are lifecycle-level guarantees.

---

# Part two — the application brought into line with those rules

The contract changes above were correct, but the **application had not caught up
with them**. A follow-up review found three places where the app still behaved as
though the old rules applied, and fixing them surfaced a fourth defect that was
more serious than any of the three.

**Commit:** [`f9d9ae2`](https://github.com/Olawalter/AgentBet/commit/f9d9ae2) ·
122 direct tests · 58 web tests · typecheck, lint and production build clean.

## 6. Resolution was still offered after `resolution_deadline`

The market page gated the Resolve action on **status alone** — `status ===
"closed"`, or open with `now >= resolution_start`. Nothing read
`resolution_deadline`, so a market whose deadline had passed still presented a
button whose transaction the contract rejects.

This was not hypothetical. Market **#0** on the deployed contract is still
`status: "open"` on-chain with its resolution deadline (`1787272208`) long past;
before the fix it showed a live "Run resolution" button.

The fix does not hide the button — it derives the market's regime from the
contract's own fields, in one place (`web/src/lib/timing.ts`), mirroring
`resolve_market` exactly:

```
now <  resolution_start                        → not_open     (staking)
resolution_start <= now <= resolution_deadline → open         (resolve legal)
resolution_deadline <  now <= recovery_deadline → closed      (nothing legal)
now >  recovery_deadline                       → recoverable  (refunds legal)
```

The `open` boundary is **inclusive at the deadline**, because the contract's
guard is `now <= resolution_deadline`. The frontend deliberately does not invent
a stricter deadline of its own — a test pins that boundary so nobody later adds a
"safety buffer" that would disagree with the chain.

Around it: a one-second clock (`useNow`) flips the UI as the deadline passes
rather than at the next interaction; `doResolve` **re-reads the market and
re-checks immediately before submitting**; and each closed state reports its own
reason, so a market someone else already resolved is not blamed on the deadline.

Market #0 now renders (captured live from the running app):

> **RESOLUTION CLOSED** — The resolution deadline passed 2026-08-21 00:30 UTC
> (18h ago) without a resolution. The contract no longer accepts one. Recovery
> opens 2026-08-24 00:30 UTC, after which any participant can open refunds and
> every stake goes back.

The elapsed figure is relative to when that was rendered; the deadline itself is
fixed at `1787272208`.

The same defect class applied to **staking**, which was also gated on status
alone: the contract refuses a stake once `now >= resolution_start`, whatever the
stored status still says. That path now carries the same clock gate and the same
pre-submit re-check.

## 7. A reverted transaction was reported as "Finalized on-chain"

This one was found while testing the race path in §6, and it is the reason that
section can be trusted at all.

Every guarantee about a late resolve — clear failure, refreshed state, no false
success — depends on the write layer **throwing** when a finalized receipt
carries an execution error. `revertReason()` decided that from
`txExecutionResultName` / `txExecutionResult` and pulled its message from
`messages[]`.

Checked against a **real reverted transaction** on the deployed contract
(`0x110977b1ad310fc2aa5f28c026859ff9b6a5db199833dbf578472d69e4a58188`, a second
claim the contract rejected):

```
txExecutionResultName : undefined
txExecutionResult     : undefined
messages              : []
```

So `revertReason()` returned `null`, the write resolved normally, and the UI
displayed **"Finalized on-chain"** for a transaction the contract had rejected.
GenLayer finalizes reverted transactions, so "finalized" was never "succeeded" —
and this affected **every write in the app**, not only resolution.

The verdict and the message are both present, just elsewhere:

```
consensus_data.leader_receipt[0].execution_result = "ERROR"
consensus_data.leader_receipt[0].result = {
  status:  "rollback",
  payload: "[EXPECTED] this position has already been settled",
}
```

`revertReason()` now reads those (keeping the previous fields as a secondary
signal for non-studio networks), strips the `[EXPECTED]` prefix, and surfaces the
contract's own words. The regression test uses that receipt's real shape and
asserts explicitly that the old field-set would have missed it.

## 8. A seven-day resolution window the contract would reject

One shared `HOURS` array fed both timing pickers, so the staking list's 7-day
option leaked into the resolution window — while the contract caps price markets
at `MAX_PRICE_RESOLUTION_WINDOW = 86400`.

Validation now lives in `web/src/lib/rules.ts`, and the mirror of that constant
is **pinned to the contract source by a test that parses
`contracts/agentbet.py`** — if the contract's cap ever changes, the test fails
rather than the two drifting apart. Invalid input is refused with a reason and
never silently clamped: `> 24h`, seven days, zero, negative, malformed and
deadline-before-instant each produce an explanation.

The resolution window now offers **1h / 6h / 12h / 24h**. The 7-day option that
remains is the **staking period**, which the contract permits and which is not
the price window — the code, the help text and a test each say so, since "7 days"
appearing anywhere near this feature invites exactly the misreading you caught.

One wording correction worth flagging: the help text originally called the 24-hour
cap the "maximum price observation window". That is inaccurate — the contract's
observation window is `OBSERVATION_WINDOW = 300s` around the instant; 24 hours is
how long *afterwards* resolution may still run. Calling it an observation window
implies the price is sampled somewhere inside a 24-hour span, which is the very
reading §2 exists to rule out. It now reads:

> Maximum resolution window for a price market: 24 hours after the instant
> (contract limit). The price itself is read only at the instant, however long
> this window is.

## 9. Settlement wording, and showing the datum next to the resolve time

Labels, help text, the generated question and the recorded `condition_text` now
name the predetermined instant rather than "resolution time". The condition
embeds the **exact epoch**, not a minute-rounded timestamp — that string is
immutable on-chain and a rounded one could sit up to 59s from the real datum.

The resolution panel now shows both timestamps together, which makes the property
self-evident on market #2:

> **Settlement datum** price observed at the predetermined instant 2026-08-21
> 03:13 UTC (epoch 1787281982) — resolution transaction ran 2026-08-21 03:14
> UTC. The second timestamp is when someone pressed the button; it did not
> change what was observed.

## Tests added

| Area | Coverage |
|---|---|
| `timing.test.ts` (11) | every regime boundary, inclusive deadline, terminal statuses, and a test that the frontend introduces no second deadline |
| `rules.test.ts` (24) | 24h accepted, `>24h` and 7-day rejected, zero/negative/malformed/ordering rejected, no clamping, every offered combination valid, and the contract-source pin |
| `revertReason.test.ts` (13) | real StudioNet receipt shapes, the explicit regression that the old field-set missed the revert, and the contract's revert phrases pinned to source |
| `tx.test.ts` (10) | a rejected late resolve never reaches `finalized`, refreshes state, and classifies as "window expired" |

Together with the 14 deadline tests from §4 and the rest of the direct suite:
**122 contract tests, 58 application tests.**

## Honest notes

- Markets **#0 and #2 carry pre-fix wording on-chain** ("…at resolution?", "four
  independent exchange feeds"). Those strings are immutable; the scripts that
  wrote them are corrected, and the Rule line renders the accurate semantics
  directly beneath the stale text. On-chain history cannot be rewritten.
- The frontend's copy asserts instant-bound semantics from `rule_kind` alone.
  `get_config` publishes neither `OBSERVATION_WINDOW` nor
  `MAX_PRICE_RESOLUTION_WINDOW`, so a client cannot *prove* from chain data that
  a deployment is the instant-bound build. Exposing both in `get_config` is the
  clean fix and needs a redeploy; it is not done here.
- The app's own timing check is advisory. The contract re-validates every bound
  with its consensus clock, and remains the only enforcement layer.
