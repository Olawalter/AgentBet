# AgentBet — Design Decisions (written before implementation)

This document fixes the storage model, lifecycle, escrow state machine, and
resolution/equivalence strategy. It is the specification the contract implements.

Every GenLayer API named here was verified against the installed SDK and proven
on a live StudioNet deployment, not assumed.

---

## 1. The trust problem this build must actually solve

Two agents disagree about a real-world fact and both have money on it. The
question is not "what does an LLM think" — it is **who is allowed to decide, and
on what evidence**. AgentBet's answer:

- money is held by the contract, never by a party or a backend;
- the evidence is fetched **by the validators under consensus**, from sources
  **no participant can edit**;
- the outcome is derived from that fetched evidence, and every field the payout
  math reads is inside the validator equivalence check;
- if the evidence cannot establish the answer, **nobody wins** — the market
  becomes refundable.

The last point is the one most prediction-market designs get wrong. An
unresolvable market that still pays somebody is a coin flip with extra steps.

---

## 2. Resolution sources — the S8 decision (creator must NOT choose editable evidence)

**Rejected design:** creator supplies a resolution URL at market creation.
That is the failure mode already confirmed on two sibling builds: an interested
party controls the bytes the validators will read, so they can change the answer
after capital is committed. Freezing the *URL* does not freeze the *content*.

**Chosen design:** the contract ships a fixed allowlist. The creator chooses a
**subject** (e.g. `BTC/USD`), not a URL. The URLs for that subject are contract
constants — multiple, mutually independent operators:

| Subject | Independent sources (historical candle endpoints) |
|---|---|
| `BTC/USD` | Bitfinex, Gemini, CoinGecko |
| `ETH/USD` | the same three operators |

Bitstamp was in this list and was removed: an on-chain probe showed it answers
from a developer machine but is unreachable from validators.

Properties this buys:
- **independent** — no participant, including the creator, can edit an
  exchange's published candle history;
- **corroborated** — a single lying or broken feed cannot decide a market
  (≥2 must agree within tolerance);
- **integrity-bound** — each fetched body is excerpted and the excerpt is
  hashed; the digest covers *the bytes actually stored*, so the record can be
  re-checked later (this is the S21 corollary — a digest over bytes nobody
  stored is unverifiable by construction).

For semantic (`EVENT_CLAIM`) markets the same principle applies at domain
granularity: the creator may cite specific pages, but only on an allowlist of
independent publishers/registries; party-hosted URLs are rejected at the
contract boundary.

---

## 3. Rule kinds

Two resolution modes share one pipeline. The architecture is not hardcoded to
the BTC demo — the market row carries its rule.

### `SPOT_THRESHOLD` (deterministic)
`observed_price (comparator) threshold` → YES/NO, decided by **Python integer
math**, not by a model. The model is not asked what it thinks the price is.

**The observation is anchored to a predetermined instant, not to resolve time.**
The price is observed at `resolution_start` — fixed at creation, the moment
staking closes. The bound URLs are historical-candle queries for that instant
(the instant is baked into the Bitfinex and CoinGecko URLs at creation; Gemini's
rolling candles are filtered by timestamp in contract code), and every extractor
validates the operator's own candle timestamp against `[instant, instant+300s]`.
Whoever runs `resolve_market`, and whenever they run it inside the window, they
get the same observation — there is no favourable live-price moment to choose.

**Honest limitation, deliberately surfaced:** one instant answers *"was it at or
above X at the observation instant"*. It cannot answer *"did it ever touch X
during the window"* — that needs full OHLC-range rules, which is future work.
Market questions must be worded to the instant, and the create form generates
them that way. The instant's observability across ≥2 independent operators is
also why a price market's resolution window is capped at 24h past the instant
(`MAX_PRICE_RESOLUTION_WINDOW`), and why resolution is legal only inside
`[resolution_start, resolution_deadline]`.

### `EVENT_CLAIM` (semantic — this is where GenLayer is load-bearing)
The contract fetches the cited allowlisted pages, then asks the model to judge
**only the fetched text** whether the stated condition occurred, returning a
structured verdict. Party-written text never enters as proof.

---

## 4. Storage model

GenLayer-native primitives only (`TreeMap`, `DynArray`, `u256`, dataclasses with
`allow_storage`). No raw dict/list persistence.

```
markets            TreeMap[str, Market]
positions          TreeMap[str, TreeMap[str, Position]]   # market -> participant hex
market_stakers     TreeMap[str, DynArray[str]]            # iteration + count
user_markets       TreeMap[Address, DynArray[str]]        # "my positions" index
resolutions        TreeMap[str, Resolution]
resolution_rows    TreeMap[str, TreeMap[u256, SourceRow]] # the fetched record
market_ids         DynArray[str]                          # listing index
reputation         TreeMap[Address, AgentStats]
```

`SourceRow` stores `url`, `readable`, `excerpt`, `digest = sha256(excerpt)`,
`observed`. The digest covers the stored excerpt — see §2.

**S10 (no unbounded scans):** every view reads a bounded slice — a market by id,
a participant's own position, a paged slice of `market_ids`. No view iterates
every position of every market.

---

## 5. Escrow — the authoritative ledger

- `stake()` is `@gl.public.write.payable`. The authoritative amount is
  **`gl.message.value`**. A caller-supplied amount is never trusted as proof of
  funds; there is no `amount` parameter.
- Identity is **`gl.message.sender_address`**. No caller-supplied wallet.
- Market terms that affect settlement are immutable once created; there is no
  setter for outcome, threshold, source, deadline, or any balance.
- A participant is bound to the side they first staked (adding to that side is
  allowed; staking the opposite side reverts). This keeps payout math trivial
  and removes a whole class of self-hedging edge cases.

Two ledger quantities per market:
- `escrow_total` — everything ever deposited (immutable record);
- `escrow_remaining` — what is still in custody (decreases only on payout/refund).

**Invariant:** `escrow_remaining == Σ(entitlement of unclaimed positions)`, and
after every position settles, `escrow_remaining == 0`. This is asserted in tests.

---

## 6. Payout formula (integer only, exact conservation)

```
T = escrow_total          (both sides' money)
W = winning side total
payout_i = floor(a_i * T / W)
```

Floor division leaves dust (< number-of-winners wei). Rather than stranding it,
**the final unclaimed winning position receives `escrow_remaining`**, sweeping
the remainder. Conservation is therefore exact, not approximate:

```
Σ payouts == escrow_total
```

Edge case — **winning side has zero stake** (everyone backed the losing side):
there is no one to pay, so the market becomes `refundable` and every
participant recovers their own stake. Funds are never awarded to a side that
staked nothing, and never stranded.

---

## 7. Lifecycle

```
open ──stake──> open ──close/deadline──> closed ──resolve──> finalized ──claim──> settled
  │                                         │                    │
  │                                         └──unresolvable──────┴──> refundable ──claim_refund──> settled
  └──cancel (only while nothing is staked)──> cancelled
```

Statuses stored: `open`, `closed`, `finalized`, `refundable`, `settled`,
`cancelled`. No invented finality state — see §8.

---

## 8. Finality — what is actually true on GenLayer (no fake finality)

The contract cannot ask "am I finalized". What is real:

1. `resolve_market` and `claim_winnings` are **separate transactions**. A claim
   can only observe a resolved market if the resolve transaction was accepted
   and its state persisted.
2. Value leaves through an external message, which GenLayer executes **on
   finalization** of the paying transaction — an accepted-but-not-final claim
   moves no money.
3. On top of those, the contract enforces an **armed settlement delay**:
   claims revert until `finalized_at + SETTLEMENT_DELAY`, measured on the
   consensus wall clock. This gives the resolution's appeal window room to run
   before any value can be drained (the S4 pattern).
4. The frontend waits for `TransactionStatus.FINALIZED` and then **re-reads
   contract state** — it never reports settlement from a submitted transaction.

The README states exactly these four mechanisms and claims no others.

---

## 9. Resolution pipeline and the equivalence set (S7 / S16 / S21 / S22 / S5)

```
fetch each allowlisted source (under consensus)
   → excerpt + sha256(excerpt) + readable flag        [the record]
   → deterministic extraction of the observation
   → corroboration: >= 2 sources agreeing within tolerance
   → SPOT_THRESHOLD: Python compares to threshold
     EVENT_CLAIM:    model judges ONLY fetched text -> structured verdict
   → structural validation of every field             [S16]
   → sufficiency gate                                 [S22]
   → outcome ∈ {YES, NO, UNRESOLVED}
```

**Equivalence must cover every field the payout math reads.** The payout math
reads exactly two things: `outcome`, and (through it) whether the market pays or
refunds. Both are pinned. Also pinned, per S21/S28, is **the record itself** —
row count, each row's URL in order, its readable flag, and that each row's digest
covers its own excerpt. Excerpt *bytes* are deliberately not compared: two honest
fetches of a live ticker differ, and demanding byte-equality there would break
consensus for the wrong reason.

Everything the model can influence is either pinned or has no path to money.

**Fail-closed, in code not in the prompt (S5/S22):**
- no source reachable → `UNRESOLVED`
- fewer than 2 corroborating readings → `UNRESOLVED`
- readings disagree beyond tolerance → `UNRESOLVED`
- malformed/garbage model output → `UNRESOLVED`
- model reports insufficient evidence → `UNRESOLVED` **regardless of which way
  it leaned** (the gate applies to YES and NO alike — gating only the positive
  verdict is the exact defect a judge letter already caught on a sibling)

`UNRESOLVED` never pays a winner. It makes the market refundable.

---

## 10. Recovery — funds must never strand (S17 / S26)

- **Timeout:** after `recovery_deadline` (resolution deadline + grace) any
  participant may call `mark_unresolved`, permissionlessly, with no counterparty
  cooperation and no owner key. The market becomes refundable.
- **Cancellation:** the creator may cancel **only** while nothing is staked.
  Once capital is committed the creator has no unilateral exit.
- Every non-terminal state has a reachable exit callable by someone who actually
  exists.

---

## 11. Value emission — one auditable path

All value leaves through a single helper `_send_gen(to, amount)` backed by an
**empty `@gl.evm.contract_interface` proxy**. This detail is load-bearing:
paying a plain wallet via `gl.get_contract_at(...).emit_transfer` treats the
recipient as a contract, the child transaction errors at finalization, and the
value is *not* refunded — contract state looks perfect while no money moves.
The proxy form is the pattern proven to actually pay an EOA.

Order at every payout, without exception:

```
READ → VALIDATE → CALCULATE → MARK CLAIMED / ZERO → PERSIST → TRANSFER
```

Never transfer before the state is written.

---

## 12. Clock

Wall-clock windows use the consensus clock: several independent
`/cdn-cgi/trace` hosts for "now" (min of corroborated readings), a chain
timestamp as a **one-directional floor** (a block cannot be in the future; a
lagging indexer must never freeze the contract), and two keyless Beacon REST
witnesses as an **independent-mechanism ceiling** so a common forward skew
across one edge provider cannot close windows early. No reachable ceiling
witness means no trusted clock, and window enforcement fails closed.

---

## 13. What is deliberately NOT built

- No custom backend. Nothing off-chain decides an outcome, a balance, or a payout.
- No frontend-computed settlement — the UI renders what the contract says.
- No mocked contract, seeded fake state, or hardcoded verdict in production code.
- No automatic loop paying every winner in the resolution transaction —
  settlement is a permissionless per-winner claim.
