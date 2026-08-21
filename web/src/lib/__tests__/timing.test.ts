/**
 * Where a market sits on its timeline — must mirror the contract's regimes
 * exactly, including the inclusive deadline boundary.
 */
import { describe, expect, it } from "vitest";
import { canRecover, canResolve, resolutionWindow, stakingOpen } from "../timing";

const START = 1_787_300_000;
const DEADLINE = START + 3600;
const RECOVERY = DEADLINE + 3 * 86_400;

const live = (status: string) => ({
  status,
  resolution_start: String(START),
  resolution_deadline: String(DEADLINE),
  recovery_deadline: String(RECOVERY),
});

describe("resolutionWindow regimes", () => {
  it("before the observation instant: not_open (staking still live)", () => {
    const w = resolutionWindow(live("open"), START - 1);
    expect(w.state).toBe("not_open");
    expect(stakingOpen(live("open"), START - 1)).toBe(true);
    expect(canResolve(live("open"), START - 1)).toBe(false);
  });

  it("at the instant: resolution opens and staking closes", () => {
    const w = resolutionWindow(live("open"), START);
    expect(w.state).toBe("open");
    expect(w.secondsLeft).toBe(DEADLINE - START);
    expect(stakingOpen(live("open"), START)).toBe(false);
    expect(canResolve(live("open"), START)).toBe(true);
  });

  it("mid-window: open", () => {
    expect(resolutionWindow(live("closed"), START + 1800).state).toBe("open");
  });

  it("exactly AT the deadline: still open — the contract's guard is `now <= deadline`, inclusive", () => {
    // The UI mirrors the authority rather than inventing a stricter edge.
    // (Anything sent this late is a near-certain race; the pre-submit re-check
    // and the contract's own guard handle the loss honestly.)
    const w = resolutionWindow(live("closed"), DEADLINE);
    expect(w.state).toBe("open");
    expect(w.secondsLeft).toBe(0);
    expect(canResolve(live("closed"), DEADLINE)).toBe(true);
  });

  it("one second after the deadline: closed — resolution is no longer offered", () => {
    const w = resolutionWindow(live("closed"), DEADLINE + 1);
    expect(w.state).toBe("closed");
    expect(canResolve(live("closed"), DEADLINE + 1)).toBe(false);
    expect(canRecover(live("closed"), DEADLINE + 1)).toBe(false);
  });

  it("long after the deadline but before recovery: still closed, nothing legal", () => {
    const w = resolutionWindow(live("open"), RECOVERY);
    expect(w.state).toBe("closed");
    expect(canResolve(live("open"), RECOVERY)).toBe(false);
    expect(canRecover(live("open"), RECOVERY)).toBe(false);
  });

  it("after the recovery deadline: recoverable — refunds may be opened, resolution never", () => {
    const w = resolutionWindow(live("open"), RECOVERY + 1);
    expect(w.state).toBe("recoverable");
    expect(canRecover(live("open"), RECOVERY + 1)).toBe(true);
    expect(canResolve(live("open"), RECOVERY + 1)).toBe(false);
  });

  it("terminal statuses never offer resolution, whatever the clock says", () => {
    for (const status of ["finalized", "refundable", "settled", "cancelled"]) {
      const w = resolutionWindow(live(status), START + 10);
      expect(w.state, status).toBe("terminal");
      expect(canResolve(live(status), START + 10)).toBe(false);
      expect(canRecover(live(status), RECOVERY + 10)).toBe(false);
    }
  });

  it("exposes the authoritative timestamps unchanged", () => {
    const w = resolutionWindow(live("open"), START);
    expect(w.opensAt).toBe(START);
    expect(w.closesAt).toBe(DEADLINE);
    expect(w.recoveryAt).toBe(RECOVERY);
  });

  it("accepts numeric as well as string epochs (contract views return strings)", () => {
    const w = resolutionWindow(
      { status: "open", resolution_start: START, resolution_deadline: DEADLINE, recovery_deadline: RECOVERY },
      START + 5,
    );
    expect(w.state).toBe("open");
  });
});

describe("the frontend never invents a second deadline", () => {
  it("the only inputs are the contract's own fields — no offsets, no grace of its own", () => {
    // If someone adds a local buffer to "be safe", open/closed would disagree
    // with the contract at the boundary. Pin the boundary to the raw fields.
    expect(resolutionWindow(live("open"), DEADLINE).state).toBe("open");
    expect(resolutionWindow(live("open"), DEADLINE + 1).state).toBe("closed");
    expect(resolutionWindow(live("open"), START - 1).state).toBe("not_open");
    expect(resolutionWindow(live("open"), START).state).toBe("open");
  });
});
