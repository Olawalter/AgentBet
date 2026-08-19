"""Market creation, staking rules, closing, cancellation.

Covers required cases 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 22.
"""

import pytest

from .conftest import to_hex

GEN = 10 ** 18


# ─── Creation ────────────────────────────────────────────────────────────────

class TestCreateMarket:
    def test_creates_open_market_with_bound_sources(self, book):
        mid = book.create_price_market()
        m = book.market(mid)
        assert mid == "0"
        assert m["status"] == "open"
        assert m["rule_kind"] == "SPOT_THRESHOLD"
        assert m["subject"] == "BTC/USD"
        assert m["creator"].lower() == to_hex(book.creator).lower()
        assert m["escrow_total"] == "0"
        # The sources are the contract's own feeds, four independent operators.
        assert len(m["resolution_sources"]) == 4
        assert all(u.startswith("https://") for u in m["resolution_sources"])

    def test_price_market_rejects_creator_supplied_sources(self, book, world):
        """The creator picks a SUBJECT, never a URL. Allowing a creator-chosen
        endpoint would let an interested party edit the bytes validators read
        after capital is committed."""
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("no sources may be supplied"):
            book.c.create_market(
                "Q", "d", "SPOT_THRESHOLD", "BTC/USD", ">=", 6000000, "cond",
                start, start + 3600,
                ["https://creator-controlled.example.com/price"],
            )

    def test_unknown_subject_rejected(self, book, world):
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("subject must be one of"):
            book.c.create_market(
                "Q", "d", "SPOT_THRESHOLD", "DOGE/USD", ">=", 100, "cond",
                start, start + 3600, [])

    def test_event_market_rejects_party_hosted_source(self, book, world):
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("not an allowlisted independent publisher"):
            book.c.create_market(
                "Q", "d", "EVENT_CLAIM", "subject", "", 0, "cond",
                start, start + 3600,
                ["https://my-own-blog.example.com/i-won"])

    def test_event_market_accepts_allowlisted_publisher(self, book):
        mid = book.create_claim_market(
            sources=["https://www.reuters.com/world/some-report"])
        assert book.market(mid)["rule_kind"] == "EVENT_CLAIM"

    def test_duplicate_sources_rejected(self, book, world):
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("duplicate source"):
            book.c.create_market(
                "Q", "d", "EVENT_CLAIM", "s", "", 0, "cond", start, start + 3600,
                ["https://www.reuters.com/a", "https://www.reuters.com/a"])

    def test_rejects_empty_question(self, book, world):
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("question must be"):
            book.c.create_market("   ", "d", "SPOT_THRESHOLD", "BTC/USD", ">=",
                                 6000000, "cond", start, start + 3600, [])

    def test_rejects_zero_threshold(self, book, world):
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("threshold must be positive"):
            book.c.create_market("Q", "d", "SPOT_THRESHOLD", "BTC/USD", ">=",
                                 0, "cond", start, start + 3600, [])

    def test_rejects_deadline_before_start(self, book, world):
        book.vm.sender = book.creator
        start = world.now + 600
        with book.vm.expect_revert("deadline must follow the start"):
            book.c.create_market("Q", "d", "SPOT_THRESHOLD", "BTC/USD", ">=",
                                 6000000, "cond", start, start - 1, [])

    def test_rejects_market_that_barely_opens(self, book, world):
        """A market must stay open long enough to actually trade."""
        book.vm.sender = book.creator
        start = world.now + 5
        with book.vm.expect_revert("must stay open for at least"):
            book.c.create_market("Q", "d", "SPOT_THRESHOLD", "BTC/USD", ">=",
                                 6000000, "cond", start, start + 3600, [])

    def test_market_ids_increment_and_list(self, book):
        a = book.create_price_market()
        b = book.create_price_market(subject="ETH/USD", threshold_cents=300000)
        assert (a, b) == ("0", "1")
        listing = book.c.list_markets(0, 10)
        assert listing["total"] == 2
        assert [i["id"] for i in listing["items"]] == ["0", "1"]

    def test_listing_is_paged(self, book):
        for _ in range(3):
            book.create_price_market()
        page = book.c.list_markets(1, 1)
        assert page["total"] == 3 and page["count"] == 1
        assert page["items"][0]["id"] == "1"


# ─── Staking ─────────────────────────────────────────────────────────────────

class TestStaking:
    def test_valid_stake_accepted_and_recorded(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 2 * GEN)
        pos = book.position(mid, book.alice)
        assert pos["exists"] is True
        assert pos["side"] == "YES"
        assert pos["amount"] == str(2 * GEN)
        m = book.market(mid)
        assert m["yes_total"] == str(2 * GEN)
        assert m["escrow_total"] == str(2 * GEN)
        assert m["escrow_remaining"] == str(2 * GEN)

    def test_zero_stake_rejected(self, book):
        mid = book.create_price_market()
        book.vm.sender = book.alice
        with book.vm.expect_revert("send GEN with this transaction"):
            book.c.stake(mid, "YES")

    def test_dust_stake_rejected(self, book):
        mid = book.create_price_market()
        book.vm.sender = book.alice
        book.vm.value = 10
        try:
            with book.vm.expect_revert("below the minimum"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0

    def test_transaction_value_is_authoritative(self, book):
        """There is no amount parameter: the ledger records the value actually
        delivered with the transaction, so a caller cannot assert funds they
        did not send."""
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 3 * GEN)
        assert book.position(mid, book.alice)["amount"] == str(3 * GEN)
        # The ABI itself carries no amount field.
        schema = book.c.get_market(mid)
        assert "amount" not in schema

    def test_identity_comes_from_sender(self, book):
        """No caller-supplied wallet: two senders produce two distinct
        positions and neither can stake on the other's behalf."""
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 1 * GEN)
        book.stake(mid, book.bob, "NO", 1 * GEN)
        assert book.position(mid, book.alice)["participant"].lower() == to_hex(book.alice).lower()
        assert book.position(mid, book.bob)["participant"].lower() == to_hex(book.bob).lower()

    def test_yes_and_no_positions_tracked_separately(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 2 * GEN)
        book.stake(mid, book.bob, "NO", 5 * GEN)
        m = book.market(mid)
        assert m["yes_total"] == str(2 * GEN)
        assert m["no_total"] == str(5 * GEN)
        assert m["escrow_total"] == str(7 * GEN)

    def test_many_participants_on_both_sides(self, book):
        """The market is not a two-agent duel — aggregate totals and individual
        positions must both hold with several stakers per side."""
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 1 * GEN)
        book.stake(mid, book.bob, "YES", 3 * GEN)
        book.stake(mid, book.carol, "NO", 2 * GEN)
        m = book.market(mid)
        assert m["yes_total"] == str(4 * GEN)
        assert m["no_total"] == str(2 * GEN)
        assert m["staker_count"] == 3
        assert m["escrow_total"] == str(6 * GEN)

    def test_adding_to_same_side_accumulates(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 1 * GEN)
        book.stake(mid, book.alice, "YES", 2 * GEN)
        assert book.position(mid, book.alice)["amount"] == str(3 * GEN)
        assert book.market(mid)["staker_count"] == 1

    def test_cannot_stake_both_sides(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 1 * GEN)
        book.vm.sender = book.alice
        book.vm.value = 1 * GEN
        try:
            with book.vm.expect_revert("you already hold a YES position"):
                book.c.stake(mid, "NO")
        finally:
            book.vm.value = 0

    def test_invalid_side_rejected(self, book):
        mid = book.create_price_market()
        book.vm.sender = book.alice
        book.vm.value = 1 * GEN
        try:
            with book.vm.expect_revert("side must be YES or NO"):
                book.c.stake(mid, "MAYBE")
        finally:
            book.vm.value = 0

    def test_staking_after_window_closes_is_rejected(self, book):
        """Time is enforced on the stake itself. A market that accepted stakes
        after its resolution window opened would be free money for whoever
        staked last."""
        mid = book.create_price_market()
        book.enter_resolution(mid)
        book.vm.sender = book.alice
        book.vm.value = 1 * GEN
        try:
            with book.vm.expect_revert("staking window has closed"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0

    def test_stake_on_unknown_market_rejected(self, book):
        book.vm.sender = book.alice
        book.vm.value = 1 * GEN
        try:
            with book.vm.expect_revert("market not found"):
                book.c.stake("999", "YES")
        finally:
            book.vm.value = 0


# ─── Closing ─────────────────────────────────────────────────────────────────

class TestClosing:
    def test_close_is_permissionless_after_window(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 1 * GEN)
        book.enter_resolution(mid)
        book.vm.sender = book.carol            # not the creator, not a staker
        book.c.close_market(mid)
        assert book.market(mid)["status"] == "closed"

    def test_cannot_close_before_window_elapses(self, book):
        mid = book.create_price_market()
        book.vm.sender = book.alice
        with book.vm.expect_revert("staking window has not elapsed"):
            book.c.close_market(mid)

    def test_staking_rejected_once_closed(self, book):
        mid = book.create_price_market()
        book.enter_resolution(mid)
        book.vm.sender = book.carol
        book.c.close_market(mid)
        book.vm.sender = book.alice
        book.vm.value = 1 * GEN
        try:
            with book.vm.expect_revert("not open for staking"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0


# ─── Creator powers (deliberately minimal) ───────────────────────────────────

class TestCreatorCannotManipulate:
    def test_creator_may_cancel_only_before_any_stake(self, book):
        mid = book.create_price_market()
        book.vm.sender = book.creator
        book.c.cancel_market(mid)
        assert book.market(mid)["status"] == "cancelled"

    def test_creator_cannot_cancel_after_capital_committed(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 1 * GEN)
        book.vm.sender = book.creator
        with book.vm.expect_revert("can no longer be cancelled"):
            book.c.cancel_market(mid)

    def test_non_creator_cannot_cancel(self, book):
        mid = book.create_price_market()
        book.vm.sender = book.alice
        with book.vm.expect_revert("only the market creator may cancel"):
            book.c.cancel_market(mid)

    def test_no_withdrawal_or_term_setters_exist(self, book):
        """The creator has no lever over money or settlement terms: there is no
        withdraw, no outcome setter, and no way to move a threshold, source or
        deadline after creation."""
        forbidden = (
            "withdraw", "set_outcome", "set_threshold", "set_status",
            "set_sources", "set_deadline", "update_market", "admin",
            "force_resolve", "sweep", "rescue",
        )
        for name in forbidden:
            assert not hasattr(book.c, name), f"unexpected privileged method: {name}"

    def test_creator_cannot_resolve_early(self, book):
        mid = book.create_price_market()
        book.stake(mid, book.alice, "YES", 1 * GEN)
        book.vm.sender = book.creator
        with book.vm.expect_revert("resolution window has not opened"):
            book.c.resolve_market(mid)

    def test_cancelled_market_rejects_stakes(self, book):
        mid = book.create_price_market()
        book.vm.sender = book.creator
        book.c.cancel_market(mid)
        book.vm.sender = book.alice
        book.vm.value = 1 * GEN
        try:
            with book.vm.expect_revert("not open for staking"):
                book.c.stake(mid, "YES")
        finally:
            book.vm.value = 0
