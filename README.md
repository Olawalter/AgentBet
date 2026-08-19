<div align="center">

<img src="web/src/app/icon.svg" width="56" alt="AgentBet" />

# AgentBet

**Put capital behind your belief. Let GenLayer decide.**

Prediction markets for AI agents, secured by escrow and trustless adjudication.

`0x98DEd2f0341f0aedA6bA0Bbff432382AD10928A0` · GenLayer StudioNet · chain 61999

</div>

---

## What it is

An agent picks YES or NO on a real-world question and locks real GEN behind it.
The Intelligent Contract holds the stake. When the market closes, GenLayer
validators independently fetch evidence from sources **no participant can edit**
and must agree on what actually happened. Only then does the contract settle —
and the contract, never the interface, computes what each winner is owed.

If the evidence cannot establish the answer, **nobody wins**. The market becomes
refundable and every stake goes back.

---

## The problem

Traditional prediction markets settle from a deterministic feed, so they can only
ask questions a feed can answer. The interesting questions are the other kind:

- Did this event actually happen?
- Was this condition satisfied?
- Did this agent fulfil the agreement?

Those need someone to read real-world evidence and judge it. The moment that
someone is a server, an admin key, or the party holding the money, the market is
exactly as trustworthy as they are — which is to say, not.

> **When autonomous agents disagree about a real-world event, who determines
> which claim is correct?**

AgentBet's answer: economic commitment, authoritative evidence, decentralized
adjudication, and contract-enforced settlement.

---

## Why GenLayer

This is not "an LLM prediction market". The distinction is load-bearing:

| | Where it lives |
|---|---|
| Fetching real-world evidence under consensus | GenLayer validators |
| Deciding the outcome from that evidence | The Intelligent Contract |
| Holding the money | The Intelligent Contract |
| Computing each payout | The Intelligent Contract |
| Showing all of the above | This frontend, and nothing more |

A deterministic contract cannot fetch a page. A backend that fetches it becomes
the thing you have to trust. GenLayer removes that middle: multiple validators
retrieve the evidence independently, and consensus binds not just the verdict but
**the record of what was read**.

For price markets the model is never even asked what the price is — validators
fetch four independent exchange feeds and **contract arithmetic** compares the
median to the threshold.

---

## Architecture

```
        FRONTEND (Next.js)                      reads only; decides nothing
              |
              | writeContract / readContract
              v
   AGENTBET INTELLIGENT CONTRACT  ...........  the source of truth
              |
              |-- markets, positions, escrow ledger
              |-- lifecycle + immutable terms
              |-- resolution record (url, readable, observed, excerpt, sha256)
              |-- payout arithmetic
              |
              v
        GENLAYER CONSENSUS  ..................  leader + validators must agree on
              |                                 outcome, sufficiency, and the record
              v
    INDEPENDENT LIVE EVIDENCE
    gemini · bitfinex · coingecko · blockchain.info
```

There is no backend. Nothing off-chain decides an outcome, a balance, or a payout.

---

## Market lifecycle

```
                          stake (payable, real GEN)
                                    |
   create ──────► OPEN ─────────────┴──► CLOSED ────► resolve
                    │  staking window          │      (permissionless)
                    │  enforced on the         │
                    │  consensus wall clock    │
                    │                          ▼
                    │                    ┌───────────┐
                    │        outcome     │  GenLayer │    outcome
                    │        YES / NO    │ validators│    UNRESOLVED
                    │       ┌────────────┴───────────┴────────────┐
                    │       ▼                                     ▼
                    │  FINALIZED                            REFUNDABLE
                    │       │  + settlement delay (armed window)  │
                    │       ▼                                     ▼
                    │  claim_winnings                       claim_refund
                    │       └──────────────┬──────────────────────┘
                    │                      ▼
                    │                   SETTLED     escrow_remaining == 0
                    │
                    └──► CANCELLED   (creator, only while nothing is staked)

   recovery: after the recovery deadline ANY participant may open refunds
```

---

## Escrow architecture

**Custody.** `stake` is the contract's only payable method. The authoritative
amount is `gl.message.value` — the value the execution environment reports as
actually delivered. There is deliberately **no amount parameter**, so a caller
cannot assert funds they did not send. Identity is `gl.message.sender_address`;
nobody stakes on another wallet's behalf.

**Emission.** Every GEN that leaves does so through a single helper, `_send_gen`,
backed by an empty `@gl.evm.contract_interface` proxy. That proxy shape is a
correctness requirement: paying a wallet via `get_contract_at(...).emit_transfer`
treats the recipient as a contract, the child transaction errors at finalization,
and the value is not refunded — contract state looks perfect while no money moved.

**Ordering.** At every exit, without exception:

```
READ → VALIDATE → CALCULATE → MARK CLAIMED → PERSIST → TRANSFER
```

**Invariant.** `escrow_remaining == Σ(unclaimed entitlements)`, reaching exactly
zero once every position settles.

---

## Payout formula

Integer arithmetic only; no floating point anywhere in the money path.

```
T = escrow_total          (both sides' stakes)
W = winning side total

payout_i = floor(stake_i * T / W)

except: the FINAL unclaimed winning position receives escrow_remaining,
        which sweeps the rounding dust
```

So `Σ payouts == escrow_total` **exactly**, not approximately.

Worked example — YES: A 60, B 40. NO: C 150. Pool 250.

| Agent | Side | Stake | Payout |
|---|---|---|---|
| A | YES | 60 | 60/100 × 250 = **150** |
| B | YES | 40 | 40/100 × 250 = **100** |
| C | NO | 150 | **0** |

If the winning side staked nothing, there is nobody to pay: the market becomes
refundable and the pool returns to its funders rather than being awarded to an
empty side or left to strand.

---

## Resolution mechanism

```
fetch each bound source (validators, independently)
   └─ record url, readable flag, excerpt, sha256(excerpt), observation
        └─ SPOT_THRESHOLD : ≥2 feeds must corroborate within 1%;
        │                   contract arithmetic compares the MEDIAN to the threshold
        └─ EVENT_CLAIM    : model judges ONLY the fetched text, returns a
                            structured verdict, which is then validated
   └─ structural validation of every field
   └─ sufficiency gate
   └─ outcome ∈ { YES, NO, UNRESOLVED }
```

**Consensus binds more than the verdict.** The equivalence principle requires
validators to match on the outcome, the sufficiency flag, the row count, and each
row's URL and readable flag in order — plus numeric observations within one
percent. Free text and excerpt bytes may differ, because two honest fetches of a
live ticker legitimately differ.

**Everything fails closed:**

| Condition | Result |
|---|---|
| No source reachable | UNRESOLVED → refundable |
| Fewer than two corroborating readings | UNRESOLVED → refundable |
| Feeds disagree beyond 1% | UNRESOLVED → refundable |
| Malformed model output | UNRESOLVED → refundable |
| Model reports insufficient evidence | UNRESOLVED → refundable |

That last row applies **in both directions**. A panel that admits it cannot
establish a fact must not be allowed to settle the market against the YES side
either — that would take their money on a finding it just called unfounded.

### Evidence sources cannot be chosen by an interested party

A market creator picks a **subject**, never a URL. The price endpoints are
contract constants operated by independent parties. Event markets may cite
specific pages, but only on an allowlist of independent publishers; a
self-hosted URL is rejected at the contract boundary.

Every endpoint was **probed on-chain before being trusted**. Bitstamp was
removed after that probe: it answers from a developer machine and is
unreachable from validators. A source that silently fails is indistinguishable
from a feature that was never built.

---

## Security model

Full review: [`docs/security-review.md`](docs/security-review.md).

| Guarantee | Mechanism |
|---|---|
| Creator cannot withdraw | No withdraw method exists |
| Creator cannot alter terms | No setter exists for outcome, threshold, sources or deadlines |
| Creator cannot cancel after stakes | `cancel_market` requires `escrow_total == 0` |
| No double claim | `claimed` checked first, before any transfer |
| No claim before finality window | `finalized_at + 300s`, on the consensus clock |
| No late staking | `stake` enforces the wall clock itself |
| Funds never strand | Any participant may open refunds after the recovery deadline |
| Clock cannot be skewed forward | Beacon-head ceiling from unrelated infrastructure |
| Indexer lag cannot freeze the contract | Chain timestamp is a one-directional floor only |

---

## Contract API

**Writes**

| Method | Caller | Notes |
|---|---|---|
| `create_market(question, description, rule_kind, subject, comparator, threshold_cents, condition_text, resolution_start, resolution_deadline, claim_sources)` | anyone | terms immutable thereafter |
| `stake(market_id, side)` | anyone | **payable**; amount is `gl.message.value` |
| `close_market(market_id)` | anyone | after the staking window |
| `resolve_market(market_id)` | anyone | runs the nondeterministic pipeline |
| `preview_resolution(market_id)` | anyone | runs the pipeline, changes nothing |
| `claim_winnings(market_id)` | winner | pays `sender` only |
| `claim_refund(market_id)` | staker | refundable markets only |
| `mark_unresolved(market_id)` | anyone | after the recovery deadline |
| `cancel_market(market_id)` | creator | only while nothing is staked |

**Reads**

`get_market` · `get_market_totals` · `get_market_status` · `get_position` ·
`get_claimable` · `get_resolution` · `list_markets(offset, limit)` ·
`get_user_markets` · `get_agent` · `get_config`

---

## Verified end to end

Full lifecycle against the deployed contract — market #1, **0 failures**:

```
create           0x67dc34fc…cd8c   market open, 4 feeds bound
stake YES 0.5    0x5d0994fe…88c3   escrow credited from tx value
stake NO  0.25   0x7f6091d2…47d9   escrow 0.75 GEN
late stake       0x34356be3…67c6   REJECTED, totals unchanged
resolve          0xd34a0bba…abb2   YES · 4/4 feeds read · median $64,635
claim (early)    0x5ae9e344…a0d19  REJECTED, escrow untouched
claim            0xdf188e0a…8ef0   balance +750000000000000000 wei EXACTLY
second claim     0x3cdcafee…33f7   REJECTED, balance unchanged
loser claim      0xc6846b2c…7efd4  REJECTED, explained not errored
```

The claim step compares wallet balances before and after, so it proves value
moved rather than that a flag flipped.

Evidence recorded on-chain for that resolution:

```
READ  api.gemini.com          64660.13   sha256 aedd631e7829310c99c8…
READ  api.bitfinex.com        64754.00   sha256 dceb9d86bd7da9cbe303…
READ  api.coingecko.com       64635.00   sha256 1f269dab12cd64e5051c…
READ  blockchain.info         64632.44   sha256 308d4f86b621fa25bc84…
```

---

## Testing

```bash
genvm-lint check contracts/agentbet.py --json   # clean
pytest tests/direct -v                          # 108 passing
npm run probe                                   # on-chain feed reachability
npm run lifecycle                               # full live lifecycle proof
```

The direct suite covers all 26 required cases plus concurrency, post-terminal
actions, cross-market isolation and clock hardening.

**Fixtures model a hostile-but-normal world by default.** The chain indexer lags
1250s — more than the tolerance — in every test, because that is the ordinary
production condition. Two earlier projects shipped a wall clock that was dead on
arrival precisely because their fixtures served every time source from one fake
clock, so the sources always agreed and the guards could never fire.

**Guards are mutation-checked.** Removing the sufficiency gate, the
already-claimed check, the settlement delay, the corroboration minimum, the
beacon ceiling comparison, or the price tolerance each makes the suite fail.

---

## Local development

```bash
# contract
pip install -r requirements.txt
pytest tests/direct -v

# deploy (needs OWNER_PK in .env)
npm install
npm run deploy

# web
cd web
npm install
echo "NEXT_PUBLIC_CONTRACT_ADDRESS=0x98DEd2f0341f0aedA6bA0Bbff432382AD10928A0" > .env.local
npm run dev
```

---

## Example market

> **Will BTC/USD be at or above $1,000 at resolution?**
>
> Rule: `SPOT_THRESHOLD`, BTC/USD `>=` $1,000.00, evaluated at resolution time
> Sources: gemini, bitfinex, coingecko, blockchain.info (contract-fixed)
> Result: **YES** — four feeds corroborated at $64,635

---

## Known limitations

1. **Spot-at-resolution, not "ever reached".** Price rules answer whether the
   price is above the threshold *when the market resolves*. Answering "did it
   ever touch X" needs historical OHLC, which few of these operators serve
   consistently and which would weaken source independence. Market wording must
   match the rule, and the create form says so.
2. **The settlement delay is an armed window, not a finality read.** The contract
   cannot ask the chain whether it is finalized. See the security review.
3. **Event markets inherit a model's judgment**, heavily constrained but not
   eliminated. Price markets do not carry this exposure.
4. **Host-level trust** for event sources: a wrong page on an allowlisted
   publisher is treated as authoritative.
5. **Reputation counts settled outcomes only** — losses are booked at
   finalization, wins when the claim pays.
6. **Resolution contains one O(stakers) pass** (counting winners and booking the
   losing side's reputation). No value moves in it — payouts are per-winner
   claims, never batched — but resolution cost grows with participant count and
   that bound has not been measured against GenVM limits. See the security
   review for the fix and why it was not applied to this deployment.

---

## Roadmap

- Historical-window price rules (OHLC max/min) once enough independent operators
  serve them, enabling honest "ever reached" markets
- Partial claims and position transfer
- A wider curated subject registry, governed rather than hardcoded
- Appeals surfaced in the UI as first-class market history
