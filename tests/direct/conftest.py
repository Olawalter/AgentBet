"""Direct-mode harness for contracts/agentbet.py.

Runs on the official gltest direct plugin: the real contract module executes
in-process while the nondeterministic boundary (gl.nondet.web.render,
gl.nondet.exec_prompt) is mocked at the VM. The equivalence-principle closures
themselves run for real, so the clock, the fetch/corroborate/decide pipeline and
the fail-closed branches are all genuinely exercised — not stubbed out.

FIXTURE DESIGN NOTE (this is the important part)

Two sibling builds once shipped a "real wall clock" that was inert on-chain
because every test fixture served all time sources from ONE fake clock. The
sources therefore always agreed, the divergence guard could never fire, and a
fail-safe that always fires is indistinguishable from a feature that was never
built.

So this World models a hostile-but-normal world BY DEFAULT:
  - the chain indexer lags by 1250s, deliberately more than the 300s tolerance,
    because that is the everyday condition that must never freeze the contract;
  - the price feeds carry small, unequal spreads like real exchanges do;
  - skew, outages, and lying sources are all directly settable per test.
"""

import json
import re

import pytest

CONTRACT_FILE = "contracts/agentbet.py"

GEN = 10 ** 18
BEACON_GENESIS = 1606824023

# A fixed "now" for reproducibility: 2026-08-20T12:00:00Z.
T0 = 1787313600


def epoch_to_iso(epoch: int) -> str:
    """Epoch -> '2026-08-20T12:00:00.000000Z' using pure integer math, so the
    fixture never depends on the host's locale or timezone."""
    days, rem = divmod(int(epoch), 86400)
    hh, rem = divmod(rem, 3600)
    mm, ss = divmod(rem, 60)
    z = days + 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    y += 1 if m <= 2 else 0
    return f"{y:04d}-{m:02d}-{d:02d}T{hh:02d}:{mm:02d}:{ss:02d}.000000Z"


def cdn_trace(epoch: int, host: str) -> str:
    return (
        f"fl=100f42\nh={host}\nip=203.0.113.7\n"
        f"ts={epoch}.401\nvisit_scheme=https\nhttp=http/2\nloc=NL\n"
    )


# Wall-clock hosts, keyed the way the contract keys them (by path, not host).
CDN_HOSTS = ("cloudflare.com", "www.digitalocean.com", "medium.com")

# Price sources now serve HISTORICAL candles bound to each market's
# observation instant (resolution_start), mirroring the real operators'
# shapes. The bodies deliberately include decoy rows OUTSIDE the observation
# window, so a contract that stopped validating timestamps would read the
# wrong price and fail these suites.
PRICE_SOURCE_IDS = ("bitfinex", "gemini", "coingecko")

# Broad per-operator host patterns, used for garbage bodies (which do not
# depend on the instant).
PRICE_HOST_PATTERNS = {
    "bitfinex":  r"api-pub\.bitfinex\.com/v2/candles/",
    "gemini":    r"api\.gemini\.com/v2/candles/",
    "coingecko": r"api\.coingecko\.com/api/v3/coins/.*/market_chart/range",
}

DECOY_CENTS = 999_999_99   # a price that would flip any test's outcome


def minute_boundary(t: int) -> int:
    """First minute boundary at or after t — where the 1m candle sits."""
    return ((int(t) + 59) // 60) * 60


def to_price(c: int) -> float:
    return float(f"{c // 100}.{c % 100:02d}")


# Default observation: BTC around $64,000, with the small per-venue spread
# real exchanges show. Well inside the contract's 1% corroboration band.
DEFAULT_PRICES_CENTS = {
    "bitfinex":  6424200,
    "gemini":    6416485,
    "coingecko": 6416100,
}

CLAIM_PROMPT_PATTERN = r"You are settling a prediction market"


class World:
    """All mock state for one test. Any mutation re-registers every mock, since
    the VM matches mocks first-come and has no callable responses."""

    def __init__(self, vm):
        self.vm = vm
        self.now = T0
        # Deliberately > MAX_CLOCK_DIVERGENCE: a lagging explorer indexer is the
        # normal condition, and it must never freeze the contract.
        self.chain_lag = 1250
        self.cdn_skew = {}          # host -> signed seconds
        self.cdn_down = set()       # hosts that fail to load
        self.beacon_delta = 0       # signed seconds applied to both witnesses
        self.beacon_down = False
        self.beacon_split = 0       # extra seconds applied to the 2nd witness
        self.chain_ahead = 0        # push the chain floor past 'now'
        self.prices = dict(DEFAULT_PRICES_CENTS)
        self.instants = set()       # observation instants of created price markets
        self.dead_sources = set()   # price sources that fail to load
        self.garbage_sources = set()  # price sources returning unparseable text
        self.claim_pages = {}       # url fragment -> body
        self.dead_pages = set()
        self.claim_verdict = None   # dict | str | None(=no mock)
        self.apply()

    # -- registration ----------------------------------------------------

    def apply(self):
        self.vm.clear_mocks()
        self._register_clock()
        self._register_prices()
        self._register_claims()
        # Keep the transaction datetime (gl.message_raw) in step with the
        # mocked web clock, so views that read the node's stamp and writes
        # that run the consensus clock see the same "now".
        #
        # vm.warp alone is NOT enough: the plugin injects its _datetime into
        # gl.message_raw once, at contract load, and _refresh_gl_message never
        # rewrites the datetime afterwards — so a warp after deploy is
        # invisible to the contract. Write the loaded module's dict directly,
        # which is exactly what the real node does per call.
        try:
            self.vm.warp(epoch_to_iso(self.now))
        except Exception:
            pass
        import sys as _sys
        gl_mod = _sys.modules.get("genlayer.gl")
        if gl_mod is not None:
            try:
                gl_mod.message_raw["datetime"] = epoch_to_iso(self.now)
            except Exception:
                pass

    def _register_clock(self):
        for host in CDN_HOSTS:
            if host in self.cdn_down:
                continue
            ts = self.now + self.cdn_skew.get(host, 0)
            self.vm.mock_web(
                re.escape(host) + r"/cdn-cgi/trace",
                {"status": 200, "body": cdn_trace(ts, host)},
            )
        chain_ts = self.now - self.chain_lag + self.chain_ahead
        self.vm.mock_web(
            r"eth\.blockscout\.com/api/v2/main-page/blocks",
            {"status": 200,
             "body": json.dumps({"items": [{"timestamp": epoch_to_iso(chain_ts)}]})},
        )
        if not self.beacon_down:
            for i, frag in enumerate(("publicnode\\.com", "chainsafe\\.io")):
                witness = self.now + self.beacon_delta + (self.beacon_split if i else 0)
                slot = (witness - BEACON_GENESIS) // 12
                self.vm.mock_web(
                    frag + r"/eth/v1/beacon/headers/head",
                    {"status": 200,
                     "body": json.dumps(
                         {"data": {"header": {"message": {"slot": str(slot)}}}})},
                )

    def _register_prices(self):
        # Garbage first: a broad host pattern that shadows the candle bodies.
        for sid in self.garbage_sources:
            if sid not in self.dead_sources:
                self.vm.mock_web(PRICE_HOST_PATTERNS[sid],
                                 {"status": 200, "body": "<html>rate limited</html>"})

        live = [s for s in PRICE_SOURCE_IDS
                if s not in self.dead_sources and s not in self.garbage_sources
                and s in self.prices]

        # Gemini serves one instant-less URL for every market, so its single
        # body carries the candle for EVERY registered instant — plus a decoy
        # outside every observation window.
        if "gemini" in live:
            rows = [[(minute_boundary(t) + 900) * 1000, to_price(DECOY_CENTS),
                     1.0, 1.0, 1.0, 0.1] for t in self.instants]
            for t in sorted(self.instants, reverse=True):
                b = minute_boundary(t) * 1000
                # [MTS, OPEN, HIGH, LOW, CLOSE, VOLUME], most-recent-first
                rows.append([b, to_price(self.prices["gemini"]), 1.0, 1.0, 1.0, 0.5])
            self.vm.mock_web(r"api\.gemini\.com/v2/candles/(btc|eth)usd/1m",
                             {"status": 200, "body": json.dumps(rows)})

        # Bitfinex and CoinGecko URLs embed the instant, so each registered
        # instant gets its own pattern and body.
        for t in self.instants:
            b_ms = minute_boundary(t) * 1000
            if "bitfinex" in live:
                # [[MTS, OPEN, CLOSE, HIGH, LOW, VOLUME], ...]. The FIRST row
                # is a decoy BEFORE the window — a compliant server never sends
                # it (sort=1&start=t), but the contract must not trust server
                # compliance: an extractor that stops validating timestamps
                # reads the decoy and fails these suites.
                body = json.dumps([
                    [(t - 900) * 1000, to_price(DECOY_CENTS), 1.0, 1.0, 1.0, 0.2],
                    [b_ms, to_price(self.prices["bitfinex"]), 1.0, 1.0, 1.0, 0.2],
                    [(t + 900) * 1000, to_price(DECOY_CENTS), 1.0, 1.0, 1.0, 0.2],
                ])
                self.vm.mock_web(
                    rf"api-pub\.bitfinex\.com/v2/candles/trade:1m:t(BTC|ETH)USD/hist\?start={t * 1000}&",
                    {"status": 200, "body": body})
            if "coingecko" in live:
                # 5-minute granularity: the qualifying point lands mid-window,
                # exactly as the real range API answers — behind a pre-window
                # decoy for the same reason as above.
                body = json.dumps({"prices": [
                    [(t - 900) * 1000, to_price(DECOY_CENTS)],
                    [(t + 141) * 1000, to_price(self.prices["coingecko"])],
                    [(t + 900) * 1000, to_price(DECOY_CENTS)],
                ]})
                self.vm.mock_web(
                    rf"api\.coingecko\.com/api/v3/coins/(bitcoin|ethereum)/market_chart/range\?vs_currency=usd&from={t}&",
                    {"status": 200, "body": body})

    def _register_claims(self):
        for frag, body in self.claim_pages.items():
            if frag in self.dead_pages:
                continue
            self.vm.mock_web(re.escape(frag), {"status": 200, "body": body})
        if self.claim_verdict is not None:
            payload = (self.claim_verdict if isinstance(self.claim_verdict, str)
                       else json.dumps(self.claim_verdict))
            self.vm.mock_llm(CLAIM_PROMPT_PATTERN, payload)

    # -- time ------------------------------------------------------------

    def advance(self, seconds):
        self.now += int(seconds)
        self.apply()
        return self.now

    def set_now(self, epoch):
        self.now = int(epoch)
        self.apply()
        return self.now

    # -- fault injection --------------------------------------------------

    def kill_all_clock_sources(self):
        self.cdn_down = set(CDN_HOSTS)
        self.apply()

    def skew_all_cdn(self, seconds):
        """A COMMON forward skew across every edge host — the exact attack the
        beacon ceiling exists to catch (min() and the divergence guard both
        pass it, because the hosts share one mechanism)."""
        self.cdn_skew = {h: seconds for h in CDN_HOSTS}
        self.apply()

    def register_instant(self, t):
        """A price market bound its observation to instant t — serve candles
        for it. Called automatically by Book.create_price_market."""
        self.instants.add(int(t))
        self.apply()

    def set_prices(self, **by_source):
        self.prices.update(by_source)
        self.apply()

    def set_all_prices(self, cents):
        self.prices = {sid: cents for sid in PRICE_SOURCES}
        self.apply()

    def kill_price_sources(self, *sids):
        self.dead_sources |= set(sids)
        self.apply()

    def garble_price_sources(self, *sids):
        self.garbage_sources |= set(sids)
        self.apply()

    def add_claim_page(self, frag, body):
        self.claim_pages[frag] = body
        self.apply()

    def set_claim_verdict(self, verdict):
        self.claim_verdict = verdict
        self.apply()


@pytest.fixture
def transfers(direct_vm):
    """Records every native-value transfer the contract emits, so tests can
    assert the recipient and the exact amount — not merely that state changed.
    (Contract state looking right while no GEN moved is a real, previously
    observed failure mode.)"""
    sent = []

    def hook(vm, request):
        for op in ("EthSend", "PostMessage"):
            if op in request:
                data = request[op]
                raw = data.get("address", b"")
                to = ("0x" + bytes(raw).hex()) if isinstance(raw, (bytes, bytearray)) else str(raw)
                sent.append({"to": to.lower(), "value": int(data.get("value", 0))})
                return {"ok": None}
        return None

    direct_vm._gl_call_hook = hook
    return sent


@pytest.fixture
def world(direct_vm):
    return World(direct_vm)


def to_hex(addr) -> str:
    if isinstance(addr, (bytes, bytearray)):
        return "0x" + bytes(addr).hex()
    s = str(addr)
    return s if s.startswith("0x") else "0x" + s


class Book:
    """Thin driver over the deployed contract for readable tests."""

    def __init__(self, contract, vm, world, accounts):
        self.c = contract
        self.vm = vm
        self.w = world
        self.creator, self.alice, self.bob, self.carol = accounts

    # market setup -------------------------------------------------------

    def create_price_market(self, *, sender=None, subject="BTC/USD",
                            comparator=">=", threshold_cents=6000000,
                            opens_in=600, window=3600, question=None):
        start = self.w.now + opens_in
        # The observation instant is fixed at creation; serve candles for it.
        self.w.register_instant(start)
        self.vm.sender = sender or self.creator
        return self.c.create_market(
            question or f"Will {subject} be at or above "
                        f"${threshold_cents // 100:,} at the observation instant?",
            "Settled from independent exchange feeds fetched under consensus.",
            "SPOT_THRESHOLD", subject, comparator, threshold_cents,
            f"{subject} {comparator} {threshold_cents // 100} at the observation instant",
            start, start + window, [],
        )

    def create_claim_market(self, *, sender=None, sources=None, opens_in=600,
                            window=3600, subject="Event under review"):
        self.vm.sender = sender or self.creator
        start = self.w.now + opens_in
        return self.c.create_market(
            "Did the cited event occur before the deadline?",
            "Settled from independent publishers fetched under consensus.",
            "EVENT_CLAIM", subject, "", 0,
            "The cited independent sources report that the event occurred.",
            start, start + window,
            sources or ["https://www.reuters.com/markets/example-report"],
        )

    def stake(self, mid, who, side, amount):
        self.vm.sender = who
        self.vm.value = int(amount)
        try:
            self.c.stake(mid, side)
        finally:
            self.vm.value = 0

    def resolve(self, mid, sender=None):
        self.vm.sender = sender or self.alice
        self.c.resolve_market(mid)

    def claim(self, mid, who):
        self.vm.sender = who
        self.c.claim_winnings(mid)

    def refund(self, mid, who):
        self.vm.sender = who
        self.c.claim_refund(mid)

    # reads --------------------------------------------------------------

    def market(self, mid):
        return self.c.get_market(mid)

    def position(self, mid, who):
        return self.c.get_position(mid, to_hex(who))

    def claimable(self, mid, who):
        return self.c.get_claimable(mid, to_hex(who))

    def resolution(self, mid):
        return self.c.get_resolution(mid)

    def agent(self, who):
        return self.c.get_agent(to_hex(who))

    # helpers ------------------------------------------------------------

    def open_for_staking(self, mid):
        """Move to just inside the staking window (markets open immediately;
        this is a no-op kept for readability)."""
        return self.w.now

    def enter_resolution(self, mid):
        m = self.market(mid)
        self.w.set_now(int(m["resolution_start"]) + 1)

    def past_settlement_delay(self, mid):
        m = self.market(mid)
        self.w.set_now(int(m["finalized_at"]) + int(m["settlement_delay"]) + 1)

    def past_recovery(self, mid):
        m = self.market(mid)
        self.w.set_now(int(m["recovery_deadline"]) + 1)


@pytest.fixture
def book(direct_vm, direct_deploy, world, direct_owner, direct_alice,
         direct_bob, direct_charlie):
    contract = direct_deploy(CONTRACT_FILE)
    return Book(contract, direct_vm, world,
                (direct_owner, direct_alice, direct_bob, direct_charlie))
