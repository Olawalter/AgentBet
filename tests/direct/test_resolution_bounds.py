"""The resolution window's UPPER bound, the predetermined observation instant,
and claimability's alignment with the settlement delay.

Steward finding this suite answers: resolution previously had no upper bound
and observed the LIVE price, so whoever called resolve_market chose the moment
the market was judged at — and after the recovery deadline both the resolve
path and the refund path were simultaneously live, a race between two
different settlements of the same money. Claimability was also advertised by
the view the instant a market finalized, 300 seconds before the write path
would accept the claim.

The properties, each tested from both directions:

  1. resolve is legal ONLY inside [resolution_start, resolution_deadline];
  2. after the deadline — and after the recovery deadline — resolve reverts,
     so resolve and refund are never both live;
  3. the observation is bound to resolution_start: resolving early or late in
     the window reads the SAME datum, and moving the live price between those
     moments changes nothing;
  4. get_claimable does not advertise a claim the write path would refuse.
"""

GEN = 10 ** 18


def _staked(book, **kw):
    mid = book.create_price_market(**kw)
    book.stake(mid, book.alice, "YES", GEN)
    book.stake(mid, book.bob, "NO", GEN)
    return mid


class TestResolutionUpperBound:
    def test_resolve_inside_the_window_works(self, book):
        mid = _staked(book)
        book.enter_resolution(mid)
        book.resolve(mid)
        assert book.market(mid)["status"] == "finalized"

    def test_resolve_at_the_last_moment_works(self, book, world):
        """Boundary: the deadline itself is still legal."""
        mid = _staked(book)
        m = book.market(mid)
        world.set_now(int(m["resolution_deadline"]))
        book.resolve(mid)
        assert book.market(mid)["status"] == "finalized"

    def test_resolve_after_the_resolution_deadline_reverts(self, book, world):
        """Focused deadline test #1: one second past the deadline, resolution
        is closed — the market's only exit is the recovery path."""
        mid = _staked(book)
        m = book.market(mid)
        world.set_now(int(m["resolution_deadline"]) + 1)
        book.vm.sender = book.alice
        with book.vm.expect_revert("resolution deadline has passed"):
            book.c.resolve_market(mid)
        # Nothing changed: no decision, escrow intact.
        m = book.market(mid)
        assert m["final_outcome"] == ""
        assert m["escrow_remaining"] == str(2 * GEN)

    def test_resolve_after_the_recovery_deadline_also_reverts(self, book, world):
        """Focused deadline test #2: past the SECOND deadline the refund path
        opens — and resolve must still be shut, or the two paths would race
        over the same escrow."""
        mid = _staked(book)
        book.past_recovery(mid)
        book.vm.sender = book.alice
        with book.vm.expect_revert("resolution deadline has passed"):
            book.c.resolve_market(mid)

    def test_refund_path_cannot_be_preempted_by_a_late_resolve(self, book, world, transfers):
        """The race the bound closes, end to end: after recovery opens, the
        loser-to-be cannot pick 'resolve now' over 'refund' — only refunds
        remain, and they pay exactly the stakes back."""
        from .conftest import to_hex
        mid = _staked(book)
        book.past_recovery(mid)

        # resolve is shut...
        book.vm.sender = book.bob
        with book.vm.expect_revert("resolution deadline has passed"):
            book.c.resolve_market(mid)

        # ...and the refund path proceeds unraced.
        book.vm.sender = book.carol
        book.c.mark_unresolved(mid)
        book.refund(mid, book.alice)
        book.refund(mid, book.bob)
        paid = {t["to"]: t["value"] for t in transfers}
        assert paid[to_hex(book.alice).lower()] == GEN
        assert paid[to_hex(book.bob).lower()] == GEN
        assert book.market(mid)["escrow_remaining"] == "0"

    def test_between_the_deadlines_the_market_simply_waits(self, book, world):
        """In the grace gap — past the resolution deadline, before the
        recovery deadline — NEITHER path is live. No decision can be
        manufactured there from either side."""
        mid = _staked(book)
        m = book.market(mid)
        world.set_now(int(m["resolution_deadline"]) + 60)
        book.vm.sender = book.alice
        with book.vm.expect_revert("resolution deadline has passed"):
            book.c.resolve_market(mid)
        with book.vm.expect_revert("recovery deadline has not passed"):
            book.c.mark_unresolved(mid)
        assert book.market(mid)["escrow_remaining"] == str(2 * GEN)

    def test_price_market_window_is_capped_at_creation(self, book, world):
        """A price market may not stretch its resolution window past the point
        where the bound instant stays observable on the operators' historical
        APIs."""
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("resolution deadline within"):
            book.c.create_market(
                "Q", "d", "SPOT_THRESHOLD", "BTC/USD", ">=", 6000000, "cond",
                start, start + 90000, [])   # > 86400s after the instant


class TestPredeterminedObservation:
    def test_caller_timing_cannot_change_the_observation(self, book, world):
        """The heart of the steward finding. Two identical markets; the live
        price moves violently between the start of the window and its end;
        one market resolves immediately, the other at the last legal moment.
        Both must report the SAME observation — the price at the bound
        instant — and therefore the same outcome."""
        early = _staked(book, threshold_cents=6400000)
        late = _staked(book, threshold_cents=6400000)

        # Resolve `early` right as its window opens.
        book.enter_resolution(early)
        book.resolve(early)

        # The market moves hard AFTER the bound instants: if the contract read
        # live prices, `late` would now resolve differently. But the candle
        # bodies for the bound instants are untouched by set_prices-at-now —
        # the fixture serves per-instant data, exactly like the operators do.
        m_late = book.market(late)
        world.set_now(int(m_late["resolution_deadline"]) - 10)
        book.resolve(late)

        r_early = book.resolution(early)
        r_late = book.resolution(late)
        assert r_early["observed_summary"] == r_late["observed_summary"]
        assert book.market(early)["final_outcome"] == book.market(late)["final_outcome"]

    def test_observed_at_is_the_bound_instant_not_resolve_time(self, book, world):
        mid = _staked(book)
        bound = int(book.market(mid)["resolution_start"])
        world.set_now(bound + 2000)          # resolve well after the instant
        book.resolve(mid)
        r = book.resolution(mid)
        assert int(r["observed_at"]) == bound
        assert int(r["resolved_at"]) >= bound + 2000
        assert str(bound) in r["reason"] or "instant" in r["reason"]

    def test_a_reading_outside_the_window_is_not_a_reading(self, book, world):
        """The fixture plants decoy candles OUTSIDE every observation window,
        including before it — the first rows a validation-free extractor would
        read. If the contract ever stops checking operator timestamps, the
        decoys ($999,999.99) leak into the readings and this market stops
        resolving NO."""
        mid = _staked(book, threshold_cents=50_000_000_00)   # >= $500k: only a decoy could pass
        book.enter_resolution(mid)
        book.resolve(mid)
        m = book.market(mid)
        assert m["final_outcome"] == "NO"          # real instant price, not the decoy
        assert book.resolution(mid)["sufficient"] is True

    def test_source_urls_embed_the_instant_at_creation(self, book):
        """The observation is predetermined in the record every trader can
        read before staking: the bound URLs carry the instant."""
        mid = book.create_price_market()
        m = book.market(mid)
        t = int(m["resolution_start"])
        joined = " ".join(m["resolution_sources"])
        assert f"start={t * 1000}" in joined        # bitfinex ms window
        assert f"from={t}" in joined                # coingecko epoch window


class TestClaimabilityAlignment:
    def _finalized(self, book):
        mid = _staked(book)
        book.enter_resolution(mid)
        book.resolve(mid)
        assert book.market(mid)["status"] == "finalized"
        return mid

    def test_view_does_not_advertise_during_the_settlement_delay(self, book):
        """Immediately after finalization the write path refuses claims for
        SETTLEMENT_DELAY seconds — so the view must say so, not render an
        enabled button that reverts."""
        mid = self._finalized(book)
        c = book.claimable(mid, book.alice)
        assert c["claimable"] is False
        assert c["kind"] == "winnings_pending"
        assert c["amount"] == str(2 * GEN)          # amount still shown
        assert "unlock" in c["reason"]

        # And the write path indeed refuses at this moment.
        book.vm.sender = book.alice
        with book.vm.expect_revert("settlement window is still open"):
            book.c.claim_winnings(mid)

    def test_view_and_write_flip_together_after_the_delay(self, book, transfers):
        mid = self._finalized(book)
        book.past_settlement_delay(mid)
        c = book.claimable(mid, book.alice)
        assert c["claimable"] is True
        assert c["kind"] == "winnings"
        book.claim(mid, book.alice)
        assert len(transfers) == 1
        assert transfers[0]["value"] == 2 * GEN

    def test_refund_claimability_needs_no_delay(self, book):
        """Refunds settle no adjudication, so there is no window to arm —
        the view may advertise them immediately."""
        mid = _staked(book)
        book.past_recovery(mid)
        book.vm.sender = book.carol
        book.c.mark_unresolved(mid)
        c = book.claimable(mid, book.alice)
        assert c["claimable"] is True
        assert c["kind"] == "refund"
