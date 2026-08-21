/**
 * The transaction driver: a write is only "finalized" when it finalized; a
 * failed write — including a late resolve the contract rejected — classifies
 * the failure AND refreshes contract state so the UI cannot sit on a stale
 * "resolvable" view.
 */
import { describe, expect, it } from "vitest";
import { classifyWriteError, runTransaction } from "../tx";
import { WrongNetworkError } from "../network";
import type { TxState } from "../types";

function recorder() {
  const states: TxState[] = [];
  let current: TxState = { phase: "idle" };
  const emit = (next: TxState | ((prev: TxState) => TxState)) => {
    current = typeof next === "function" ? next(current) : next;
    states.push(current);
  };
  return { states, emit, get current() { return current; } };
}

describe("classifyWriteError maps the contract's deadline revert to an explained state", () => {
  it("recognises the resolve-after-deadline revert", () => {
    // Exact phrase from contracts/agentbet.py resolve_market, after the
    // [EXPECTED] prefix is stripped by the contract layer.
    const c = classifyWriteError(new Error(
      "the resolution deadline has passed — this market can only be recovered for refunds now (mark_unresolved after the recovery deadline)",
    ));
    expect(c.kind).toBe("resolution_closed");
    expect(c.message).toMatch(/resolution window has expired/i);
    expect(c.message).not.toMatch(/success/i);
  });

  it("recognises resolve-before-open", () => {
    const c = classifyWriteError(new Error("the resolution window has not opened yet"));
    expect(c.kind).toBe("resolution_not_open");
  });

  it("recognises a closed staking window", () => {
    expect(classifyWriteError(new Error("the staking window has closed")).kind).toBe("staking_closed");
    expect(classifyWriteError(new Error("market is not open for staking")).kind).toBe("staking_closed");
  });

  it("keeps wrong-network errors verbatim", () => {
    const c = classifyWriteError(new WrongNetworkError("Switch to GenLayer StudioNet (chain 61999)."));
    expect(c.kind).toBe("wrong_network");
    expect(c.message).toMatch(/61999/);
  });

  it("recognises wallet rejection by code and by message", () => {
    const byCode = Object.assign(new Error("boom"), { code: 4001 });
    expect(classifyWriteError(byCode).kind).toBe("user_rejected");
    expect(classifyWriteError(new Error("User rejected the request")).kind).toBe("user_rejected");
  });

  it("passes other contract rejections through with their reason", () => {
    const c = classifyWriteError(new Error("this position has already been settled"));
    expect(c.kind).toBe("contract_rejected");
    expect(c.message).toBe("this position has already been settled");
  });
});

describe("runTransaction lifecycle", () => {
  it("a successful write walks awaiting → submitted → pending → finalized, then after, then refresh", async () => {
    const r = recorder();
    const calls: string[] = [];
    const ok = await runTransaction(
      async (hooks) => {
        hooks.onSubmitted?.("0xabc");
        hooks.onPending?.();
        return "0xabc";
      },
      r.emit,
      {
        after: () => { calls.push("after"); },
        refresh: () => { calls.push("refresh"); },
      },
    );
    expect(ok).toBe(true);
    expect(r.states.map((s) => s.phase)).toEqual(["awaiting_wallet", "submitted", "pending", "finalized"]);
    expect(r.current.hash).toBe("0xabc");
    expect(calls).toEqual(["after", "refresh"]);
  });

  it("a late resolve the contract rejected: failed + explained + state refreshed, and `after` never runs", async () => {
    const r = recorder();
    const calls: string[] = [];
    const ok = await runTransaction(
      async (hooks) => {
        hooks.onSubmitted?.("0xdead");
        hooks.onPending?.();
        // The contract layer throws this after a FINALIZED receipt carrying an
        // execution error — GenLayer finalizes reverted transactions too.
        throw new Error("the resolution deadline has passed — this market can only be recovered for refunds now");
      },
      r.emit,
      {
        after: () => { calls.push("after"); },
        refresh: () => { calls.push("refresh"); },
      },
    );
    expect(ok).toBe(false);
    expect(r.current.phase).toBe("failed");
    expect(r.current.errorKind).toBe("resolution_closed");
    expect(r.current.error).toMatch(/expired/i);
    // Never "Resolution successful" — and the page re-reads contract state so
    // the resolve button disappears and "Resolution closed" is shown.
    expect(calls).toEqual(["refresh"]);
    expect(r.states.some((s) => s.phase === "finalized")).toBe(false);
  });

  it("a failure before submission (wallet rejected) still refreshes and never finalizes", async () => {
    const r = recorder();
    let refreshed = 0;
    const ok = await runTransaction(
      async () => { throw Object.assign(new Error("denied"), { code: 4001 }); },
      r.emit,
      { refresh: () => { refreshed += 1; } },
    );
    expect(ok).toBe(false);
    expect(r.current.phase).toBe("failed");
    expect(r.current.errorKind).toBe("user_rejected");
    expect(refreshed).toBe(1);
  });

  it("a throwing refresh does not convert a finalized write into a failure", async () => {
    const r = recorder();
    const ok = await runTransaction(
      async () => "0x1",
      r.emit,
      { refresh: () => { throw new Error("rpc blip"); } },
    );
    expect(ok).toBe(true);
    expect(r.current.phase).toBe("finalized");
  });
});
