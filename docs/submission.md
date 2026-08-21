# AgentBet — Submission Notes

Contract: `0xb37208B984c7Fc56df6c07913cca6d5062f0451A` (GenLayer StudioNet, chain 61999)
Source: [`contracts/agentbet.py`](../contracts/agentbet.py)

---

### 1. What does AgentBet do?

Agents take an economically backed position on a real-world question. One picks
YES, another NO, and both send real GEN with the transaction. The Intelligent
Contract holds the stakes. When the market closes, GenLayer validators fetch
evidence independently and must agree on the outcome. The contract then computes
each winner's share of the pool and pays it out on a permissionless claim.

### 2. What trust problem does it solve?

When two agents disagree about something that happened in the world, somebody
has to read the evidence and decide. Every conventional answer to "who?" is a
party you must trust: a server, an admin key, an oracle operator, or the side
holding the money. AgentBet removes the trusted middle. The evidence is fetched
by validators who must agree with each other, from sources that no participant —
including the market's own creator — is able to edit.

The second half of the answer matters as much: when the evidence *cannot*
establish the outcome, nobody wins. The market becomes refundable. A market that
pays somebody regardless of what the evidence supports is a coin flip with a
narrative attached.

### 3. Why is GenLayer necessary?

A deterministic contract cannot fetch a web page, and an off-chain service that
fetches it becomes the thing you must trust. GenLayer is the only layer here that
can do the fetch *and* be trustless about it, because multiple validators do it
independently and have to agree.

The agreement covers more than the verdict. The equivalence principle pins the
outcome, the sufficiency flag, the number of evidence rows, and each row's URL
and readable flag in order. So a dishonest leader cannot agree on "YES" while
writing a fabricated record of what it read.

Note what is deliberately *not* delegated to a model: for price markets no model
is asked what the price is or what the answer should be. Validators fetch four
independent feeds; **contract arithmetic** corroborates them and compares the
median to the threshold. The model's judgment is used only where the question is
genuinely semantic (`EVENT_CLAIM`), and even there it is structurally validated
and gated.

### 4. Which Intelligent Contract is used?

One contract, `AgentBet`, in `contracts/agentbet.py` — 19 methods (10 view, 9
write), pinned to runner
`py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`. Storage uses
GenLayer-native primitives only: `TreeMap`, `DynArray`, `u256`, and dataclasses
with `allow_storage`.

### 5. How does real escrow work?

`stake` is the contract's only payable method and it has **no amount
parameter**. The ledger is credited from `gl.message.value` — the value the
execution environment reports as actually delivered — so a caller cannot assert
funds they did not send. The participant is `gl.message.sender_address`, so
nobody can stake on another wallet's behalf.

All value leaves through a single helper, `_send_gen`, which pays through an
empty `@gl.evm.contract_interface` proxy. That detail is load-bearing: paying an
externally-owned account via `get_contract_at(...).emit_transfer` makes the
child transaction error at finalization without refunding, which leaves contract
state looking perfect while no GEN moved.

Every exit follows `READ → VALIDATE → CALCULATE → MARK CLAIMED → PERSIST →
TRANSFER`, and the invariant `escrow_remaining == Σ(unclaimed entitlements)`
holds throughout, reaching exactly zero when every position has settled.

### 6. How does resolution work?

Per market, at resolution: fetch each bound source; record url, readable flag,
excerpt, `sha256(excerpt)` and the extracted observation; then

- **`SPOT_THRESHOLD`** — require at least two readings corroborating within 1%,
  take the median, and compare it to the threshold in Python;
- **`EVENT_CLAIM`** — put only the fetched text in front of the model, wrapped in
  fences the prompt names as untrusted, and require a structured verdict.

The verdict is then structurally validated (types checked, enums checked) and
passed through a sufficiency gate. Anything malformed, unreachable,
uncorroborated, contradictory or inconclusive yields `UNRESOLVED`.

### 7. What authoritative data is used?

Four independent operators for BTC/USD: Gemini, Bitfinex, CoinGecko and
blockchain.info. These are **contract constants**. The market creator chooses a
*subject*, never a URL, so an interested party cannot point the market at bytes
they control. Event markets may cite specific pages but only on an allowlist of
independent publishers (Reuters, AP, BBC, SEC, Federal Reserve, europa.eu, NASA,
WHO, UN, Nature, Science).

Every endpoint was probed **on-chain** before being trusted, using
`preview_resolution`, which runs the real pipeline and returns the finding
without touching state. That probe removed Bitstamp from the design: it answers
fine from a developer machine and is unreachable from validators. A
nondeterministic source that silently fails looks exactly like a feature that was
never built.

### 8. How does GenLayer consensus affect settlement?

Settlement reads exactly two things the consensus produced: the outcome, and
whether the finding was sufficient. Both are inside the equivalence check, along
with the evidence record itself. If validators do not agree on those, the
resolution does not land, and with no resolution there is nothing to claim
against — the market eventually falls to the recovery path and refunds.

### 9. How does the frontend interact with the contract?

Reads go through a keyless client so browsing works on any wallet network.
Writes go through the connected wallet and are gated by `ensureActiveChain()`,
which reconciles the wallet to StudioNet and then **re-reads the chain id to
confirm** before a transaction is ever built. (Skipping that produces
`chainId should be same as current chainId` at signature time — an error that
reads like an app bug rather than "you are on the wrong network".)

The frontend computes no outcome, no eligibility and no payout. The claim button
renders `get_claimable`, which is the contract's own arithmetic.

### 10. How is finality verified?

Honestly, and with its limits stated:

1. resolving and claiming are **separate transactions**, so a claim can only
   observe a resolved market if the resolve transaction landed;
2. value leaves via an external message that GenLayer executes **on
   finalization**, so an accepted-but-not-final claim moves nothing;
3. on top of those, the contract enforces an **armed settlement window** —
   claims revert until `finalized_at + 300s` on the consensus wall clock, giving
   the resolution's appeal window room to run;
4. the frontend waits for `TransactionStatus.FINALIZED` and then **re-reads
   contract state**, and it inspects the receipt for an execution error, because
   GenLayer finalizes reverted transactions too.

What this is *not*: the contract cannot ask the chain "am I finalized". No flag
is invented to pretend otherwise.

### 11. How is double settlement prevented?

The position carries a `claimed` flag, checked immediately after the position is
loaded and **before** any transfer. The flag, the payout, the decremented
`escrow_remaining` and the settled counter are all written and persisted before
`_send_gen` is called. A second claim therefore fails at the guard, long before
the payout path.

Verified live: the second claim transaction was rejected on-chain and the
winner's balance was byte-identical before and after
(`216069999999999999900` → `216069999999999999900`).

### 12. How can someone reproduce the demo?

```bash
pip install -r requirements.txt
pytest tests/direct -v            # 108 passing, no network needed

npm install
cp .env.example .env              # add OWNER_PK and BETTOR_PK (funded StudioNet keys)
npm run probe                     # prove the feeds are reachable from validators
npm run lifecycle                 # full lifecycle with balance assertions
npm run state -- 1                # dump market #1: terms, record, digests
```

For the UI: `cd web && npm install && npm run dev`, set
`NEXT_PUBLIC_CONTRACT_ADDRESS`, connect a wallet on chain 61999.

### 13. What are the limitations?

1. Price rules observe **one predetermined instant** (`resolution_start`), not "ever reached during the window";
   honest OHLC support needs more independent operators serving it.
2. The settlement delay is an armed window, not a finality read (see 10).
3. Event markets inherit a model's judgment — constrained by structural
   validation, the sufficiency gate and the equivalence check, but not
   eliminated. Price markets carry no such exposure.
4. Event source trust is **host-level**: a wrong page on an allowlisted
   publisher is treated as authoritative.
5. Feed reachability is an operational dependency; if enough feeds go dark
   simultaneously, markets fail closed to refundable — the safe direction, but a
   liveness cost.
6. Reentrancy is not simulated in tests, because `emit_transfer` queues a message
   rather than making a synchronous call; the ordering guarantee is asserted
   instead.
7. Resolution is one-shot: there is no in-contract appeal that re-runs the
   pipeline after a disputed finding.

### 14. What is the path to production?

- **Subject registry as governed state** rather than contract constants, so feeds
  can be added or retired without redeploying — with a timelock, since changing a
  live market's sources must remain impossible.
- **Historical-window rules** (OHLC) to support "ever reached" questions
  honestly.
- **An appeal path** that re-runs resolution under a fresh validator set when a
  finding is contested, with a bond to make contests costly.
- **Wider corroboration** — more feeds per subject and a quorum that scales with
  the size of the pool at risk.
- Independent audit of the escrow paths, and a testnet run with real
  multi-participant volume before mainnet.
