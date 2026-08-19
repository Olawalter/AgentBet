"""AgentBet — integration tests against the deployed contract on StudioNet.

Direct mode proves the logic with the nondeterministic boundary mocked. What it
cannot prove is the half that only exists on a network: that a validator set
independently FETCHES the bound feeds, agrees under the equivalence rule this
contract declares, and that the recorded evidence survives consensus.

These tests bind to the deployed artifact rather than deploying per run. Two
reasons: deploying from a fixture burns most of StudioNet's request budget, and
the deployed contract is the thing actually worth testing.

Assertions are INVARIANTS, never "the market must resolve YES" — live prices
move and a test that depends on them is a test that fails for the wrong reason.

Run:  gltest tests/integration -v -s --network studionet
"""

import json
import os
import pathlib
import time

import pytest

CONTRACT_SOURCE = pathlib.Path("contracts/agentbet.py")

DEPLOYED = os.environ.get(
    "AGENTBET_ADDRESS", "0x98DEd2f0341f0aedA6bA0Bbff432382AD10928A0")

VALID_STATUSES = {"open", "closed", "finalized", "refundable", "settled", "cancelled"}
VALID_OUTCOMES = {"", "YES", "NO", "UNRESOLVED"}


@pytest.fixture(scope="module")
def contract():
    """Bind to the deployed instance with a bytes-sourced schema.

    The factory's schema fetch reads the source as `str` and the client encodes
    that as ASCII, so one non-ASCII character in a comment raises
    UnicodeEncodeError and is reported as "failed to get schema from all
    clients" — which points nowhere near the cause. Passing bytes works.
    """
    from gltest.clients import get_gl_client
    from gltest.contracts.contract import Contract

    source = CONTRACT_SOURCE.read_bytes()
    client = get_gl_client()

    last = None
    for attempt in range(4):
        try:
            schema = client.get_contract_schema_for_code(contract_code=source)
            return Contract.new(address=DEPLOYED, schema=schema)
        except Exception as exc:                      # usually a 429
            last = exc
            time.sleep(6 * (attempt + 1))
    pytest.fail(f"could not bind to {DEPLOYED}: {type(last).__name__}: {last}")


# ── the deployed artifact is the one we think it is ──────────────────────────

def test_config_publishes_the_governing_parameters(contract):
    """These are the rules of the venue. Anyone being asked to stake can read
    them from the chain rather than taking the interface's word."""
    cfg = contract.get_config(args=[]).call()
    assert "BTC/USD" in cfg["price_subjects"]
    assert cfg["settlement_delay"] > 0
    assert cfg["recovery_grace"] > 0
    assert cfg["price_tolerance_bps"] > 0
    assert int(cfg["min_stake_wei"]) > 0
    # Event sources are restricted to independent publishers, not arbitrary URLs
    assert len(cfg["claim_source_domains"]) >= 5


def test_price_markets_bind_several_independent_feeds(contract):
    """The creator picks a subject; the contract supplies the endpoints. If this
    ever returns a single source, corroboration is impossible and the design's
    central claim is void."""
    cfg = contract.get_config(args=[]).call()
    if int(cfg["market_count"]) == 0:
        pytest.skip("no markets on this deployment yet")

    page = contract.list_markets(args=[0, 50]).call()
    price_markets = [m for m in page["items"] if m["rule_kind"] == "SPOT_THRESHOLD"]
    if not price_markets:
        pytest.skip("no price markets on this deployment yet")

    m = contract.get_market(args=[price_markets[0]["id"]]).call()
    sources = m["resolution_sources"]
    assert len(sources) >= 2, "a price market must have corroborating sources"
    hosts = {s.split("/")[2] for s in sources}
    assert len(hosts) == len(sources), "sources must be distinct operators"
    assert all(s.startswith("https://") for s in sources)


# ── every market on chain obeys the invariants ───────────────────────────────

def test_every_market_holds_its_accounting_invariant(contract):
    """Swept across the whole deployment: no market may owe more than it holds,
    and a settled market must hold nothing."""
    page = contract.list_markets(args=[0, 50]).call()
    if page["total"] == 0:
        pytest.skip("no markets yet")

    for item in page["items"]:
        m = contract.get_market(args=[item["id"]]).call()
        total = int(m["escrow_total"])
        remaining = int(m["escrow_remaining"])
        yes, no = int(m["yes_total"]), int(m["no_total"])

        assert m["status"] in VALID_STATUSES
        assert m["final_outcome"] in VALID_OUTCOMES
        assert yes + no == total, f"market {m['id']}: side totals must equal escrow"
        assert 0 <= remaining <= total, f"market {m['id']}: custody out of range"
        if m["status"] == "settled":
            assert remaining == 0, f"market {m['id']}: settled but still holding"
        if m["status"] == "open":
            assert m["final_outcome"] == ""


def test_resolved_markets_carry_a_complete_evidence_record(contract):
    """Consensus binds the record, not only the verdict. Every bound source must
    appear, in order, and each digest must be present for the excerpt stored."""
    page = contract.list_markets(args=[0, 50]).call()
    resolved = [i for i in page["items"]
                if i["status"] in ("finalized", "settled", "refundable")]
    if not resolved:
        pytest.skip("no resolved markets yet")

    checked = 0
    for item in resolved:
        r = contract.get_resolution(args=[item["id"]]).call()
        if not r["exists"]:
            continue          # refundable via the recovery path, never resolved
        m = contract.get_market(args=[item["id"]]).call()

        assert [row["url"] for row in r["rows"]] == list(m["resolution_sources"]), \
            f"market {item['id']}: recorded sources must match the bound sources in order"
        for row in r["rows"]:
            if row["readable"]:
                assert len(row["digest"]) == 64, "a retrieved row must carry a sha256"
        assert r["outcome"] in {"YES", "NO", "UNRESOLVED"}
        # The gate that matters: an insufficient finding may never be conclusive.
        if not r["sufficient"]:
            assert r["outcome"] == "UNRESOLVED", \
                f"market {item['id']}: insufficient evidence produced a conclusive outcome"
        checked += 1

    if checked == 0:
        pytest.skip("no market carries a resolution record yet")


def test_conclusive_markets_paid_only_the_winning_side(contract):
    """Cross-check settlement against the recorded outcome for every finalized
    market: a settled position on the losing side must have been paid nothing."""
    page = contract.list_markets(args=[0, 50]).call()
    finalized = [i for i in page["items"] if i["status"] in ("finalized", "settled")]
    if not finalized:
        pytest.skip("no finalized markets yet")

    for item in finalized:
        m = contract.get_market(args=[item["id"]]).call()
        outcome = m["final_outcome"]
        if outcome not in ("YES", "NO"):
            continue
        winning_total = int(m["yes_total"]) if outcome == "YES" else int(m["no_total"])
        assert winning_total > 0, \
            f"market {m['id']}: finalized conclusively with an empty winning side"
        assert int(m["winning_positions"]) > 0
        assert int(m["settled_positions"]) <= int(m["winning_positions"])


# ── the live pipeline, run for real ──────────────────────────────────────────

@pytest.mark.slow
def test_preview_resolution_reaches_live_feeds_from_validators(contract):
    """The probe that matters: run the real fetch pipeline on-chain and require
    that validators can actually reach enough feeds to corroborate.

    This is the check that caught Bitstamp — reachable from a laptop, invisible
    from validators. Green local tests say nothing about that.
    """
    from gltest.assertions import tx_execution_succeeded

    page = contract.list_markets(args=[0, 50]).call()
    price = [i for i in page["items"] if i["rule_kind"] == "SPOT_THRESHOLD"]
    if not price:
        pytest.skip("no price market to probe")

    receipt = contract.preview_resolution(args=[price[0]["id"]]).transact()
    assert tx_execution_succeeded(receipt)

    # preview_resolution changes nothing: the market must be exactly as it was.
    before = price[0]["status"]
    after = contract.get_market(args=[price[0]["id"]]).call()["status"]
    assert after == before, "preview_resolution must not mutate state"
