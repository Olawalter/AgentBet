"""Escrow custody, proportional settlement, and the guarantees that protect it.

Covers required cases 15, 16, 17, 18, 19, 20, 21, 25, 26.

Every payout assertion checks the emitted TRANSFER (recipient and exact amount),
not merely that a claimed flag flipped. Contract state looking correct while no
value actually moved is a real failure mode this portfolio has hit before.
"""

from .conftest import to_hex

GEN = 10 ** 18


def _settled_yes(book, *, yes=None, no=None, threshold_cents=6000000):
    """Build a market that resolves YES (spot ~$64k >= $60k), staked as given."""
    mid = book.create_price_market(threshold_cents=threshold_cents)
    for who, amount in (yes or []):
        book.stake(mid, who, "YES", amount)
    for who, amount in (no or []):
        book.stake(mid, who, "NO", amount)
    book.enter_resolution(mid)
    book.resolve(mid)
    return mid


class TestOutcomes:
    def test_finalized_yes(self, book):
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        m = book.market(mid)
        assert m["final_outcome"] == "YES"
        assert m["status"] == "finalized"
        assert book.resolution(mid)["sufficient"] is True

    def test_finalized_no(self, book):
        """Same feeds, threshold above spot: the condition is not met."""
        mid = book.create_price_market(threshold_cents=99_000_000)   # >= $990,000
        book.stake(mid, book.alice, "YES", GEN)
        book.stake(mid, book.bob, "NO", GEN)
        book.enter_resolution(mid)
        book.resolve(mid)
        m = book.market(mid)
        assert m["final_outcome"] == "NO"
        assert m["status"] == "finalized"

    def test_comparator_lte_is_honoured(self, book):
        mid = book.create_price_market(comparator="<=", threshold_cents=99_000_000)
        book.stake(mid, book.alice, "YES", GEN)
        book.stake(mid, book.bob, "NO", GEN)
        book.enter_resolution(mid)
        book.resolve(mid)
        assert book.market(mid)["final_outcome"] == "YES"

    def test_resolution_records_the_fetched_evidence(self, book):
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        r = book.resolution(mid)
        assert r["exists"] is True
        assert r["row_count"] == 4
        for row in r["rows"]:
            assert row["url"].startswith("https://")
            assert row["readable"] is True
            assert row["observed"]
            # The digest must cover the bytes actually stored, or the record
            # could never be re-checked by anyone.
            assert len(row["digest"]) == 64
        assert r["observed_summary"]


class TestPayout:
    def test_single_winner_takes_the_whole_pool(self, book, transfers):
        mid = _settled_yes(book, yes=[(book.alice, 2 * GEN)], no=[(book.bob, GEN)])
        book.past_settlement_delay(mid)
        assert book.claimable(mid, book.alice)["amount"] == str(3 * GEN)
        book.claim(mid, book.alice)

        assert len(transfers) == 1
        assert transfers[0]["to"] == to_hex(book.alice).lower()
        assert transfers[0]["value"] == 3 * GEN
        m = book.market(mid)
        assert m["escrow_remaining"] == "0"
        assert m["status"] == "settled"

    def test_proportional_split_between_multiple_winners(self, book, transfers):
        """YES: alice 60, bob 40. NO: carol 150. Pool 250.
        alice -> 60% of 250 = 150, bob -> 40% of 250 = 100."""
        mid = _settled_yes(
            book,
            yes=[(book.alice, 60 * GEN), (book.bob, 40 * GEN)],
            no=[(book.carol, 150 * GEN)],
        )
        book.past_settlement_delay(mid)
        assert book.claimable(mid, book.alice)["amount"] == str(150 * GEN)
        assert book.claimable(mid, book.bob)["amount"] == str(100 * GEN)

        book.claim(mid, book.alice)
        book.claim(mid, book.bob)

        paid = {t["to"]: t["value"] for t in transfers}
        assert paid[to_hex(book.alice).lower()] == 150 * GEN
        assert paid[to_hex(book.bob).lower()] == 100 * GEN
        assert sum(t["value"] for t in transfers) == 250 * GEN
        assert book.market(mid)["escrow_remaining"] == "0"

    def test_rounding_dust_is_swept_by_the_final_claimant(self, book, transfers):
        """Indivisible pool: floor division would strand wei. The last winning
        position takes the remainder so the payouts sum to the pool exactly."""
        mid = _settled_yes(
            book,
            yes=[(book.alice, 1 * GEN + 1), (book.bob, 1 * GEN)],
            no=[(book.carol, 1 * GEN)],
        )
        pool = 3 * GEN + 1
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)
        book.claim(mid, book.bob)

        assert sum(t["value"] for t in transfers) == pool
        assert book.market(mid)["escrow_remaining"] == "0"
        assert book.market(mid)["status"] == "settled"

    def test_winners_only_side_gets_stake_back(self, book, transfers):
        """Everyone backed YES and YES won: there is no losing money, so each
        winner simply recovers their own stake."""
        mid = _settled_yes(book, yes=[(book.alice, 2 * GEN), (book.bob, GEN)])
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)
        book.claim(mid, book.bob)
        paid = {t["to"]: t["value"] for t in transfers}
        assert paid[to_hex(book.alice).lower()] == 2 * GEN
        assert paid[to_hex(book.bob).lower()] == 1 * GEN

    def test_losing_position_cannot_claim(self, book, transfers):
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        book.past_settlement_delay(mid)
        book.vm.sender = book.bob
        with book.vm.expect_revert("your position was NO"):
            book.c.claim_winnings(mid)
        assert transfers == []

    def test_loser_sees_settled_position_not_an_error(self, book):
        """A losing position is a settled outcome, not a failed transaction —
        the contract reports why, with the amount at zero."""
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        c = book.claimable(mid, book.bob)
        assert c["claimable"] is False
        assert c["amount"] == "0"
        assert "resolved YES" in c["reason"]

    def test_non_participant_cannot_claim(self, book, transfers):
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        book.past_settlement_delay(mid)
        book.vm.sender = book.carol
        with book.vm.expect_revert("you hold no position"):
            book.c.claim_winnings(mid)
        assert transfers == []


class TestDoubleSpendProtection:
    def test_second_claim_is_rejected_and_moves_no_value(self, book, transfers):
        mid = _settled_yes(book, yes=[(book.alice, 2 * GEN)], no=[(book.bob, GEN)])
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)
        assert len(transfers) == 1

        book.vm.sender = book.alice
        with book.vm.expect_revert("already been settled"):
            book.c.claim_winnings(mid)

        # The decisive assertion: no SECOND transfer was emitted.
        assert len(transfers) == 1
        assert book.market(mid)["escrow_remaining"] == "0"

    def test_state_is_written_before_value_leaves(self, book, transfers):
        """The claimed flag, the ledger and the counter are all persisted before
        the transfer is emitted, so a repeat can never reach the payout."""
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)

        pos = book.position(mid, book.alice)
        assert pos["claimed"] is True
        assert pos["payout"] == str(2 * GEN)
        assert book.market(mid)["escrow_remaining"] == "0"
        assert book.market(mid)["settled_positions"] == 1
        assert len(transfers) == 1

    def test_double_refund_is_rejected(self, book, transfers, world):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", GEN)
        book.past_recovery(mid)
        book.vm.sender = book.alice
        book.c.mark_unresolved(mid)

        book.refund(mid, book.alice)
        assert len(transfers) == 1
        book.vm.sender = book.alice
        with book.vm.expect_revert("already been settled"):
            book.c.claim_refund(mid)
        assert len(transfers) == 1


class TestFinalityProtection:
    def test_claim_before_settlement_window_is_refused(self, book, transfers):
        """Value cannot be drained until the resolution has had time to be
        appealed — an armed window, enforced on the consensus clock."""
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        book.vm.sender = book.alice
        with book.vm.expect_revert("settlement window is still open"):
            book.c.claim_winnings(mid)
        assert transfers == []

    def test_claim_succeeds_once_the_window_elapses(self, book, transfers):
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)
        assert len(transfers) == 1

    def test_claimable_view_publishes_the_unlock_time(self, book):
        mid = _settled_yes(book, yes=[(book.alice, GEN)], no=[(book.bob, GEN)])
        m = book.market(mid)
        c = book.claimable(mid, book.alice)
        assert c["claimable_at"] == str(int(m["finalized_at"]) + int(m["settlement_delay"]))

    def test_cannot_claim_on_an_unresolved_market(self, book, transfers):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", GEN)
        book.vm.sender = book.alice
        with book.vm.expect_revert("no claimable outcome"):
            book.c.claim_winnings(mid)
        assert transfers == []


class TestAccountingInvariant:
    def _remaining_equals_unclaimed(self, book, mid, participants):
        m = book.market(mid)
        outstanding = 0
        for who in participants:
            pos = book.position(mid, who)
            if pos["exists"] and not pos["claimed"]:
                c = book.claimable(mid, who)
                outstanding += int(c["amount"]) if c["claimable"] else 0
        return int(m["escrow_remaining"]), outstanding

    def test_escrow_equals_sum_of_stakes_before_resolution(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 3 * GEN)
        book.stake(mid, book.bob, "NO", 5 * GEN)
        book.stake(mid, book.carol, "NO", 2 * GEN)
        m = book.market(mid)
        total = sum(int(book.position(mid, w)["amount"])
                    for w in (book.alice, book.bob, book.carol))
        assert int(m["escrow_total"]) == total
        assert int(m["escrow_remaining"]) == total

    def test_remaining_tracks_outstanding_entitlements_through_settlement(self, book):
        parties = (book.alice, book.bob, book.carol)
        mid = _settled_yes(
            book,
            yes=[(book.alice, 60 * GEN), (book.bob, 40 * GEN)],
            no=[(book.carol, 150 * GEN)],
        )
        book.past_settlement_delay(mid)

        remaining, outstanding = self._remaining_equals_unclaimed(book, mid, parties)
        assert remaining == outstanding == 250 * GEN

        book.claim(mid, book.alice)
        remaining, outstanding = self._remaining_equals_unclaimed(book, mid, parties)
        assert remaining == outstanding == 100 * GEN

        book.claim(mid, book.bob)
        remaining, _ = self._remaining_equals_unclaimed(book, mid, parties)
        assert remaining == 0
        assert book.market(mid)["status"] == "settled"

    def test_payouts_sum_exactly_to_the_pool(self, book, transfers):
        mid = _settled_yes(
            book,
            yes=[(book.alice, 7 * GEN), (book.bob, 3 * GEN)],
            no=[(book.carol, 11 * GEN)],
        )
        pool = int(book.market(mid)["escrow_total"])
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)
        book.claim(mid, book.bob)
        assert sum(t["value"] for t in transfers) == pool

    def test_refunds_sum_exactly_to_the_pool(self, book, transfers):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 4 * GEN)
        book.stake(mid, book.bob, "NO", 6 * GEN)
        pool = int(book.market(mid)["escrow_total"])
        book.past_recovery(mid)
        book.vm.sender = book.carol
        book.c.mark_unresolved(mid)
        book.refund(mid, book.alice)
        book.refund(mid, book.bob)
        assert sum(t["value"] for t in transfers) == pool
        assert book.market(mid)["escrow_remaining"] == "0"


class TestReputation:
    def test_stats_derive_from_contract_state(self, book):
        mid = _settled_yes(book, yes=[(book.alice, 2 * GEN)], no=[(book.bob, GEN)])
        book.past_settlement_delay(mid)
        book.claim(mid, book.alice)

        winner = book.agent(book.alice)
        loser = book.agent(book.bob)
        assert winner["markets"] == 1
        assert winner["correct"] == 1
        assert winner["staked_wei"] == str(2 * GEN)
        assert winner["won_wei"] == str(3 * GEN)
        assert winner["accuracy_bps"] == 10000
        assert loser["incorrect"] == 1
        assert loser["accuracy_bps"] == 0

    def test_unknown_agent_reads_as_empty(self, book):
        a = book.agent(book.carol)
        assert a["markets"] == 0 and a["staked_wei"] == "0"
