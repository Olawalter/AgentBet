"""The clock, the recovery path, and system-level invariants.

Covers required cases 23, 24, 25, plus the concurrency and post-terminal
classes that scripted happy-path suites miss.

On the clock tests specifically: every other test in this repo runs with the
chain indexer lagging 1250s — deliberately more than the 300s tolerance —
because that is the ordinary condition in production. Two sibling projects once
shipped a wall clock that was dead on arrival precisely because their fixtures
served every time source from one fake clock, so the sources always agreed and
the guards could never fire.
"""

GEN = 10 ** 18


class TestClockHardening:
    def test_a_lagging_chain_indexer_never_freezes_the_contract(self, book, world):
        """The chain timestamp is a one-directional FLOOR. A block behind proves
        nothing — indexer lag is unbounded and routine — so it must not be
        treated as clock disagreement."""
        world.chain_lag = 86400          # a full day behind
        world.apply()
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", GEN)
        assert book.market(mid)["escrow_total"] == str(GEN)

    def test_a_block_stamped_in_the_future_fails_closed(self, book, world):
        """A block cannot exist ahead of now. If one appears to, the clock has
        been rolled back or spoofed and no window may be enforced."""
        world.chain_ahead = 5000
        world.apply()
        book.vm.sender = book.creator
        with book.vm.expect_revert("time sources unreachable or unreliable"):
            book.c.create_market(
                "Q", "d", "SPOT_THRESHOLD", "BTC/USD", ">=", 6000000, "cond",
                world.now + 600, world.now + 4200, [])

    def test_no_wall_clock_source_fails_closed(self, book, world):
        mid = book.create_price_market()
        world.kill_all_clock_sources()
        book.vm.sender = book.alice
        book.vm.value = GEN
        try:
            with book.vm.expect_revert("time sources unreachable or unreliable"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0

    def test_one_edge_host_down_is_tolerated(self, book, world):
        mid = book.create_price_market()
        world.cdn_down = {"medium.com"}
        world.apply()
        book.stake(mid, book.alice, "YES", GEN)
        assert book.market(mid)["escrow_total"] == str(GEN)

    def test_common_forward_skew_is_caught_by_the_beacon_ceiling(self, book, world):
        """The edge hosts share one mechanism, so a skew that moves them all
        together survives both min() and the divergence guard. Beacon head time
        comes from unrelated infrastructure: a clock running ahead of the
        freshest witness is exactly the skew that would close windows early, and
        it is refused."""
        mid = book.create_price_market()
        world.skew_all_cdn(4000)         # every trace host reports the future
        book.vm.sender = book.alice
        book.vm.value = GEN
        try:
            with book.vm.expect_revert("time sources unreachable or unreliable"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0

    def test_one_edge_host_lying_is_caught_by_divergence(self, book, world):
        mid = book.create_price_market()
        world.cdn_skew = {"medium.com": 9000}
        world.apply()
        book.vm.sender = book.alice
        book.vm.value = GEN
        try:
            with book.vm.expect_revert("time sources unreachable or unreliable"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0

    def test_no_beacon_witness_means_no_clock(self, book, world):
        """Fail closed, not open: an attacker able to skew every edge host can
        also block a beacon probe, so an optional ceiling would vanish precisely
        under attack."""
        mid = book.create_price_market()
        world.beacon_down = True
        world.apply()
        book.vm.sender = book.alice
        book.vm.value = GEN
        try:
            with book.vm.expect_revert("time sources unreachable or unreliable"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0

    def test_beacon_witnesses_disagreeing_refuse_to_set_a_ceiling(self, book, world):
        """Head lag is seconds. A minutes-wide gap between two reachable
        witnesses means one is lying or on the wrong chain, and max() must not
        be allowed to adopt the liar."""
        mid = book.create_price_market()
        world.beacon_split = 6000
        world.apply()
        book.vm.sender = book.alice
        book.vm.value = GEN
        try:
            with book.vm.expect_revert("time sources unreachable or unreliable"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0


class TestRecovery:
    def test_recovery_cannot_be_triggered_early(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", GEN)
        book.vm.sender = book.alice
        with book.vm.expect_revert("recovery deadline has not passed"):
            book.c.mark_unresolved(mid)

    def test_any_participant_may_open_refunds_after_the_deadline(self, book):
        """Terminal escape: no counterparty cooperation, no creator, no owner
        key. Funds cannot strand behind a market that never resolved."""
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", GEN)
        book.past_recovery(mid)
        book.vm.sender = book.carol        # not the creator, not even a staker
        book.c.mark_unresolved(mid)
        m = book.market(mid)
        assert m["status"] == "refundable"
        assert m["final_outcome"] == "UNRESOLVED"

    def test_refund_returns_exactly_the_original_stake(self, book, transfers):
        from .conftest import to_hex
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 3 * GEN)
        book.stake(mid, book.bob, "NO", 2 * GEN)
        book.past_recovery(mid)
        book.vm.sender = book.alice
        book.c.mark_unresolved(mid)

        book.refund(mid, book.alice)
        book.refund(mid, book.bob)
        paid = {t["to"]: t["value"] for t in transfers}
        assert paid[to_hex(book.alice).lower()] == 3 * GEN
        assert paid[to_hex(book.bob).lower()] == 2 * GEN

    def test_recovery_is_refused_once_a_market_is_finalized(self, book):
        mid = book.create_price_market(threshold_cents=6000000)
        book.stake(mid, book.alice, "YES", GEN)
        book.enter_resolution(mid)
        book.resolve(mid)
        book.past_recovery(mid)
        book.vm.sender = book.alice
        with book.vm.expect_revert("already reached a terminal state"):
            book.c.mark_unresolved(mid)

    def test_refund_rejected_on_a_live_market(self, book, transfers):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", GEN)
        book.vm.sender = book.alice
        with book.vm.expect_revert("not refundable"):
            book.c.claim_refund(mid)
        assert transfers == []

    def test_unresolved_resolution_also_opens_refunds(self, book, world, transfers):
        """The other route to refundable: the sources were reachable but could
        not establish an answer."""
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", GEN)
        world.kill_price_sources("blockchain", "gemini", "bitfinex", "coingecko")
        book.enter_resolution(mid)
        book.resolve(mid)
        assert book.market(mid)["status"] == "refundable"
        book.refund(mid, book.alice)
        assert transfers[0]["value"] == GEN


class TestPostTerminalActions:
    """Actions attempted after a market has reached a terminal state. Scripted
    happy-path suites never try these, and they are where state machines leak."""

    def _settled(self, book):
        mid = book.create_price_market(threshold_cents=6000000)
        book.stake(mid, book.alice, "YES", GEN)
        book.stake(mid, book.bob, "NO", GEN)
        book.enter_resolution(mid)
        book.resolve(mid)
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)
        assert book.market(mid)["status"] == "settled"
        return mid

    def test_no_staking_after_settlement(self, book):
        mid = self._settled(book)
        book.vm.sender = book.carol
        book.vm.value = GEN
        try:
            with book.vm.expect_revert("not open for staking"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0

    def test_no_resolution_after_settlement(self, book):
        mid = self._settled(book)
        book.vm.sender = book.carol
        with book.vm.expect_revert("already reached a terminal state"):
            book.c.resolve_market(mid)

    def test_no_recovery_after_settlement(self, book):
        mid = self._settled(book)
        book.past_recovery(mid)
        book.vm.sender = book.carol
        with book.vm.expect_revert("already reached a terminal state"):
            book.c.mark_unresolved(mid)

    def test_no_refund_on_a_settled_winning_market(self, book, transfers):
        mid = self._settled(book)
        before = len(transfers)
        book.vm.sender = book.bob         # the losing side
        with book.vm.expect_revert("not refundable"):
            book.c.claim_refund(mid)
        assert len(transfers) == before

    def test_no_close_after_settlement(self, book):
        mid = self._settled(book)
        book.vm.sender = book.carol
        with book.vm.expect_revert("market is not open"):
            book.c.close_market(mid)

    def test_no_cancel_after_settlement(self, book):
        mid = self._settled(book)
        book.vm.sender = book.creator
        with book.vm.expect_revert("market is not open"):
            book.c.cancel_market(mid)


class TestConcurrentClaims:
    """Several winners settling against one pool. The reserve must never be
    spent twice and the pool must never over-pay, whatever the order."""

    def test_three_winners_cannot_overdraw_the_pool(self, book, transfers):
        mid = book.create_price_market(threshold_cents=6000000)
        book.stake(mid, book.alice, "YES", 5 * GEN)
        book.stake(mid, book.bob, "YES", 3 * GEN)
        book.stake(mid, book.carol, "YES", 2 * GEN)
        book.stake(mid, book.creator, "NO", 10 * GEN)
        pool = int(book.market(mid)["escrow_total"])
        book.enter_resolution(mid)
        book.resolve(mid)
        book.past_settlement_delay(mid)

        for who in (book.carol, book.alice, book.bob):     # deliberately out of order
            book.claim(mid, who)
            m = book.market(mid)
            # The invariant that matters at every intermediate step:
            assert int(m["escrow_remaining"]) >= 0
            assert sum(t["value"] for t in transfers) + int(m["escrow_remaining"]) == pool

        assert sum(t["value"] for t in transfers) == pool
        assert book.market(mid)["escrow_remaining"] == "0"
        assert book.market(mid)["status"] == "settled"

    def test_a_winner_claiming_twice_amid_others_takes_nothing_extra(self, book, transfers):
        mid = book.create_price_market(threshold_cents=6000000)
        book.stake(mid, book.alice, "YES", GEN)
        book.stake(mid, book.bob, "YES", GEN)
        book.stake(mid, book.carol, "NO", 4 * GEN)
        pool = int(book.market(mid)["escrow_total"])
        book.enter_resolution(mid)
        book.resolve(mid)
        book.past_settlement_delay(mid)

        book.claim(mid, book.alice)
        book.vm.sender = book.alice
        with book.vm.expect_revert("already been settled"):
            book.c.claim_winnings(mid)
        book.claim(mid, book.bob)

        assert sum(t["value"] for t in transfers) == pool
        assert len(transfers) == 2

    def test_refunds_by_several_parties_conserve_the_pool(self, book, transfers):
        mid = book.create_price_market()
        for who, amt in ((book.alice, 2 * GEN), (book.bob, 3 * GEN),
                         (book.carol, 5 * GEN)):
            book.stake(mid, who, "YES" if amt % 2 else "NO", amt)
        pool = int(book.market(mid)["escrow_total"])
        book.past_recovery(mid)
        book.vm.sender = book.alice
        book.c.mark_unresolved(mid)

        for who in (book.bob, book.carol, book.alice):
            book.refund(mid, who)
            m = book.market(mid)
            assert sum(t["value"] for t in transfers) + int(m["escrow_remaining"]) == pool

        assert book.market(mid)["escrow_remaining"] == "0"
        assert sum(t["value"] for t in transfers) == pool


class TestCrossMarketIsolation:
    def test_markets_do_not_share_escrow(self, book, transfers):
        """A claim in one market must never reach another market's custody."""
        a = book.create_price_market(threshold_cents=6000000)
        b = book.create_price_market(threshold_cents=6000000)
        book.stake(a, book.alice, "YES", 2 * GEN)
        book.stake(b, book.bob, "YES", 7 * GEN)

        book.enter_resolution(a)
        book.resolve(a)
        book.past_settlement_delay(a)
        book.claim(a, book.alice)

        assert transfers[-1]["value"] == 2 * GEN          # not 9
        assert book.market(b)["escrow_remaining"] == str(7 * GEN)
        assert book.market(b)["status"] == "open"

    def test_a_position_in_one_market_grants_nothing_in_another(self, book):
        a = book.create_price_market(threshold_cents=6000000)
        b = book.create_price_market(threshold_cents=6000000)
        book.stake(a, book.alice, "YES", GEN)
        book.enter_resolution(b)
        book.resolve(b)
        book.past_settlement_delay(b)
        book.vm.sender = book.alice
        with book.vm.expect_revert("you hold no position in this market"):
            book.c.claim_winnings(b)
