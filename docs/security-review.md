# AgentBet — Escrow Security Review

Scope: `contracts/agentbet.py` as deployed at
`0x98DEd2f0341f0aedA6bA0Bbff432382AD10928A0` (GenLayer StudioNet).

The review enumerates every path by which value enters or leaves the contract
and checks each against the same fixed list of properties. It also records the
things that are *not* protected, because a review that only lists strengths is
marketing.

---

## 1. Every path where money ENTERS

| # | Path | Method | Authority for the amount |
|---|---|---|---|
| 1 | Staking | `stake(market_id, side)` | `gl.message.value` |

That is the complete list. There is exactly one payable method in the contract.

**Why the amount cannot be faked:** `stake` has no amount parameter. It is
physically impossible for a caller to assert a figure, because there is nowhere
to put one — the ledger is credited from the value the execution environment
reports as actually delivered. Identity is `gl.message.sender_address` for the
same reason: there is no participant parameter to spoof.

Checks applied before any credit:
- side ∈ {YES, NO};
- market status is `open`;
- `value > 0` and `value >= MIN_STAKE_WEI`;
- the wall clock (consensus-verified) is before `resolution_start`;
- the staker is not already on the opposite side.

---

## 2. Every path where money LEAVES

There is exactly **one emission function**, `_send_gen`, and every exit calls it.

| # | Exit | Method | Recipient | Amount source |
|---|---|---|---|---|
| 1 | Winnings | `claim_winnings` | `gl.message.sender_address` | `_entitlement()` over the stored ledger |
| 2 | Refund | `claim_refund` | `gl.message.sender_address` | the caller's own recorded stake |

Cancellation moves no value: a market can only be cancelled while
`escrow_total == 0`, so there is nothing to return. `mark_unresolved` moves no
value either; it only opens path 2.

**The recipient is never a parameter.** Both exits pay
`gl.message.sender_address`. There is no method anywhere that accepts a payout
address, so there is no path by which one account can direct another's funds.

### 2.1 The emission helper

`_send_gen` pays through an **empty `@gl.evm.contract_interface` proxy**. This
is a correctness requirement, not a style choice: paying a plain wallet through
`gl.get_contract_at(addr).emit_transfer(...)` treats the recipient as an
Intelligent Contract, the child transaction errors at finalization, and the
deducted value is not refunded. Contract state would look perfect — claimed
flags set, ledger zeroed — while no GEN ever moved. The proxy form is the one
verified to actually pay an externally-owned account, and the live run below
confirms it with a balance delta.

---

## 3. Per-payout checklist

Applied to both exits.

| Property | `claim_winnings` | `claim_refund` |
|---|---|---|
| Recipient is correct | pays `sender`, never a parameter | pays `sender` |
| Amount comes from contract storage | `_entitlement()` from `escrow_total` / side totals | `pos.amount` |
| Amount > 0 | asserted | asserted |
| Amount ≤ custody | asserted against `escrow_remaining` | asserted against `escrow_remaining` |
| Authorization | position must exist and be on the winning side | position must exist |
| Lifecycle state | status must be `finalized`, outcome conclusive | status must be `refundable` |
| Finality gate | `now >= finalized_at + SETTLEMENT_DELAY` | n/a (no adjudication to appeal) |
| State updated before transfer | `claimed`, `payout`, `escrow_remaining`, `settled_positions` | same |
| State persisted before transfer | `self.markets[id] = m` precedes `_send_gen` | same |
| Second execution cannot pay | `not pos.claimed` is checked first | same |
| Accounting invariant preserved | `escrow_remaining` decremented by exactly the payout | same |

**Ordering, without exception:**

```
READ → VALIDATE → CALCULATE → MARK CLAIMED → PERSIST → TRANSFER
```

The `claimed` check is deliberately the *first* thing tested after the position
is loaded, before the market-status check. This ordering was changed during
testing: previously a repeat claimer on a fully-settled market received
"this market has no claimable outcome" instead of "already settled". The
double-spend guard held either way, but the message pointed at the wrong fact.

---

## 4. Accounting invariant

```
escrow_remaining == Σ (entitlement of every unclaimed position)
```

and after every position settles, `escrow_remaining == 0`.

Conservation is **exact, not approximate**. Proportional payouts use floor
division, which normally strands dust; here the final unclaimed winning position
receives `escrow_remaining` outright, sweeping the remainder. So:

```
Σ payouts == escrow_total
```

This is asserted directly in `test_payouts_sum_exactly_to_the_pool`,
`test_rounding_dust_is_swept_by_the_final_claimant`, and — at every intermediate
step, not only at the end — in `test_three_winners_cannot_overdraw_the_pool`.

---

## 5. Threats considered

| Threat | Outcome |
|---|---|
| Caller claims funds twice | Rejected at `not pos.claimed`, before any transfer. Verified live: second claim moved 0 wei. |
| Loser claims | Rejected on the side check. |
| Non-participant claims | Rejected on position existence. |
| Claim against another market's escrow | Custody is per market; `escrow_remaining` is a market field. Covered by `test_markets_do_not_share_escrow`. |
| Creator drains the pool | No withdraw method exists; cancellation requires `escrow_total == 0`. |
| Creator edits terms after stakes | No setter exists for any settlement-affecting field. Asserted by `test_no_withdrawal_or_term_setters_exist`. |
| Creator points the market at evidence they control | The creator chooses a *subject*, not a URL. Price endpoints are contract constants; event markets are restricted to an allowlist of independent publishers. |
| Late staking once the answer is knowable | `stake` enforces the wall clock itself, not merely a status flag. |
| A single lying or broken feed decides a market | At least two readings must corroborate within 1%; the median decides. |
| Model returns malformed or hostile output | Structurally validated; anything unparseable resolves UNRESOLVED. |
| Model says "insufficient" but leans an answer | Gated in both directions — an insufficient finding can never settle YES *or* NO. |
| Fetched page contains prompt injection | Fence delimiters are stripped from retrieved bytes; the prompt names the fetched block as untrusted material. |
| Clock skewed forward to close windows early | Beacon-head ceiling from unrelated infrastructure refuses a clock ahead of the freshest witness. |
| Explorer indexer lag freezes the contract | The chain timestamp is a one-directional floor only; lag is tolerated without bound. |
| Funds stranded in a market that never resolves | Any participant may call `mark_unresolved` after the recovery deadline — no owner key, no counterparty. |
| Winning side staked nothing | Market becomes refundable; the pool returns to its funders rather than being awarded to an empty side. |

---

## 6. Known limitations — stated plainly

1. **The settlement delay is a window, not a proof of finality.** The contract
   cannot ask the chain "am I finalized". What it does is: separate the
   resolving transaction from the claiming transaction, refuse claims until
   `finalized_at + 300s`, and rely on GenLayer executing the outbound value
   message only at finalization. That is real protection, and it is not the same
   thing as reading a finality flag.

2. **Reentrancy is not simulated in tests.** `emit_transfer` queues an external
   message rather than making a synchronous call, so a classic reentrant
   callback is not reachable in the same way as on an EVM chain. Tests assert
   state-before-transfer ordering and that a second claim emits nothing; they do
   not model a reentrant callback, because the mechanism does not provide one.

3. **Price rules are spot-at-resolution.** They answer "is the price at or above
   X when the market resolves", not "did it ever touch X during the window".
   Market wording must match, and the UI says so.

4. **Feed reachability is an operational dependency.** Bitstamp was removed from
   the allowlist after an on-chain probe showed it is unreachable from
   validators even though it answers from a developer machine. If enough feeds
   become unreachable simultaneously, markets fail closed to refundable — the
   safe direction, but it is a liveness cost.

5. **Event markets inherit the judgment of a model.** The structural validation,
   the sufficiency gate and the equivalence check constrain it heavily, but a
   confidently wrong reading of a genuinely retrieved page can still settle an
   event market. Price markets do not have this exposure: no model is asked what
   the price is.

6. **Host-level trust for event sources.** The allowlist grants trust at domain
   granularity. A compromised or erroneous page on an allowlisted publisher is
   treated as authoritative.

7. **Resolution contains one O(stakers) pass.** `resolve_market` walks the
   market's own staker list once, to count winning positions and to book the
   losing side's reputation. No value is transferred in that loop — settlement
   is a separate per-winner claim, which is the part the design deliberately
   refuses to batch — but resolution cost still grows with participant count,
   and that bound has not been measured against GenVM execution limits. A market
   with a very large number of distinct stakers could therefore become expensive
   or unresolvable. The fix is known and cheap (maintain `yes_positions` /
   `no_positions` counters at stake time, making the money-critical path
   loop-free, and book losing reputation lazily); it is not applied here because
   it changes the storage layout, which would invalidate the deployed contract
   that every live proof in this document was run against. It is the first
   change to make before any deployment expecting large markets.

---

## 7. Live verification

Full lifecycle against the deployed contract, market #1 — **0 failures**:

| Step | Transaction | Result |
|---|---|---|
| create | `0x67dc34fc…cd8c` | market open, 4 feeds bound |
| stake YES 0.5 GEN | `0x5d0994fe…88c3` | escrow credited |
| stake NO 0.25 GEN | `0x7f6091d2…47d9` | escrow 0.75 GEN |
| late stake | `0x34356be3…67c6` | **rejected**, totals unchanged |
| resolve | `0xd34a0bba…abb2` | YES, 4/4 feeds read, median $64,635 |
| claim before window | `0x5ae9e344…a0d19` | **rejected**, escrow untouched |
| claim | `0xdf188e0a…8ef0` | **balance +750000000000000000 wei exactly** |
| second claim | `0x3cdcafee…33f7` | **rejected**, balance unchanged |
| loser claim | `0xc6846b2c…7efd4` | **rejected**, explained not errored |

The claim assertion compares wallet balances before and after, so it proves the
value moved — not merely that a flag flipped.

Direct suite: **108 tests passing**. `genvm-lint check`: clean. Critical guards
were mutation-checked: removing the sufficiency gate, the already-claimed guard,
the settlement delay, the corroboration minimum, the beacon ceiling comparison
or the price-tolerance check each makes the suite fail.
