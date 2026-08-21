/**
 * Market-timing rules: the frontend must never OFFER what the contract will
 * REJECT, and the two sources of the rule must not be able to drift apart.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  MAX_MARKET_WINDOW_SECONDS,
  MAX_PRICE_RESOLUTION_WINDOW_SECONDS,
  RESOLUTION_WINDOW_OPTIONS,
  STAKING_OPEN_OPTIONS,
  describeDuration,
  validateMarketTiming,
} from "../rules";

const CONTRACT = fs.readFileSync(
  path.resolve(__dirname, "../../../../contracts/agentbet.py"),
  "utf-8",
);

function contractConstant(name: string): number {
  const m = CONTRACT.match(new RegExp(`^${name}\\s*=\\s*([0-9_*\\s]+?)\\s*(#|$)`, "m"));
  if (!m) throw new Error(`constant ${name} not found in contract source`);
  // The contract writes some caps as products (`365 * 24 * 3600`). Evaluate
  // that one shape by hand — no eval, no Function constructor.
  return m[1]
    .replace(/_/g, "")
    .split("*")
    .map((t) => Number(t.trim()))
    .reduce((acc, n) => {
      if (!Number.isFinite(n)) throw new Error(`unparseable term in ${name}: ${m[1]}`);
      return acc * n;
    }, 1);
}

const NOW = 1_787_300_000;
const base = { nowSec: NOW, ruleKind: "SPOT_THRESHOLD" as const, minMarketWindow: 120 };

describe("the frontend mirrors of contract caps are pinned to the contract source", () => {
  it("MAX_PRICE_RESOLUTION_WINDOW matches contracts/agentbet.py", () => {
    expect(MAX_PRICE_RESOLUTION_WINDOW_SECONDS).toBe(contractConstant("MAX_PRICE_RESOLUTION_WINDOW"));
  });
  it("MAX_MARKET_WINDOW matches contracts/agentbet.py", () => {
    expect(MAX_MARKET_WINDOW_SECONDS).toBe(contractConstant("MAX_MARKET_WINDOW"));
  });
  it("the one-day cap is exactly 24 hours", () => {
    expect(MAX_PRICE_RESOLUTION_WINDOW_SECONDS).toBe(24 * 3600);
  });
});

describe("offered options never exceed what the contract accepts", () => {
  it("no resolution-window option exceeds the one-day price cap", () => {
    for (const o of RESOLUTION_WINDOW_OPTIONS) {
      expect(o.seconds).toBeGreaterThan(0);
      expect(o.seconds).toBeLessThanOrEqual(MAX_PRICE_RESOLUTION_WINDOW_SECONDS);
    }
  });
  it("no seven-day resolution window is offered", () => {
    expect(RESOLUTION_WINDOW_OPTIONS.some((o) => o.seconds === 604_800)).toBe(false);
    expect(RESOLUTION_WINDOW_OPTIONS.some((o) => /7 days|week/i.test(o.label))).toBe(false);
  });
  it("the longest resolution window offered is exactly 24 hours", () => {
    expect(Math.max(...RESOLUTION_WINDOW_OPTIONS.map((o) => o.seconds))).toBe(86_400);
  });
  it("staking-open options stay inside the contract's one-year bound", () => {
    for (const o of STAKING_OPEN_OPTIONS) {
      expect(o.seconds).toBeGreaterThan(0);
      expect(o.seconds).toBeLessThanOrEqual(MAX_MARKET_WINDOW_SECONDS);
    }
  });
  it("every offered combination validates for a price market", () => {
    for (const open of STAKING_OPEN_OPTIONS) {
      for (const win of RESOLUTION_WINDOW_OPTIONS) {
        const r = validateMarketTiming({ ...base, openFor: open.seconds, windowFor: win.seconds });
        expect(r.ok, `${open.label} / ${win.label}`).toBe(true);
      }
    }
  });
});

describe("validateMarketTiming — price markets (one-day window)", () => {
  it("accepts a 24-hour window", () => {
    const r = validateMarketTiming({ ...base, openFor: 3600, windowFor: 86_400 });
    expect(r.ok).toBe(true);
    expect(r.resolutionStart).toBe(NOW + 3600);
    expect(r.resolutionDeadline).toBe(NOW + 3600 + 86_400);
  });
  it("accepts windows shorter than 24 hours", () => {
    for (const w of [1, 60, 3600, 43_200, 86_399]) {
      expect(validateMarketTiming({ ...base, openFor: 3600, windowFor: w }).ok).toBe(true);
    }
  });
  it("rejects 24 hours + 1 second", () => {
    const r = validateMarketTiming({ ...base, openFor: 3600, windowFor: 86_401 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/24 hours/);
  });
  it("rejects a seven-day window", () => {
    const r = validateMarketTiming({ ...base, openFor: 3600, windowFor: 604_800 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/contract rejects longer windows/);
  });
  it("does NOT silently clamp — the invalid value is rejected with a reason, not rewritten", () => {
    const r = validateMarketTiming({ ...base, openFor: 3600, windowFor: 604_800 });
    expect(r.resolutionDeadline).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it("rejects a zero window (deadline would equal the instant)", () => {
    const r = validateMarketTiming({ ...base, openFor: 3600, windowFor: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/deadline must come after/);
  });
  it("rejects a negative window (deadline before the instant)", () => {
    expect(validateMarketTiming({ ...base, openFor: 3600, windowFor: -60 }).ok).toBe(false);
  });
  it("rejects malformed durations", () => {
    expect(validateMarketTiming({ ...base, openFor: 3600, windowFor: NaN }).ok).toBe(false);
    expect(validateMarketTiming({ ...base, openFor: 3600, windowFor: 1.5 }).ok).toBe(false);
    expect(validateMarketTiming({ ...base, openFor: 3600, windowFor: Infinity }).ok).toBe(false);
  });
  it("rejects an unusable clock", () => {
    expect(validateMarketTiming({ ...base, nowSec: 0, openFor: 3600, windowFor: 3600 }).ok).toBe(false);
    expect(validateMarketTiming({ ...base, nowSec: NaN, openFor: 3600, windowFor: 3600 }).ok).toBe(false);
  });
});

describe("validateMarketTiming — staking duration", () => {
  it("enforces the contract's minimum open window from get_config", () => {
    const r = validateMarketTiming({ ...base, openFor: 119, windowFor: 3600 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/at least 120 seconds/);
    expect(validateMarketTiming({ ...base, openFor: 120, windowFor: 3600 }).ok).toBe(true);
  });
  it("rejects zero and negative staking durations", () => {
    expect(validateMarketTiming({ ...base, openFor: 0, windowFor: 3600 }).ok).toBe(false);
    expect(validateMarketTiming({ ...base, openFor: -1, windowFor: 3600 }).ok).toBe(false);
  });
  it("rejects staking open longer than a year", () => {
    expect(validateMarketTiming({ ...base, openFor: MAX_MARKET_WINDOW_SECONDS + 1, windowFor: 3600 }).ok).toBe(false);
  });
  it("a seven-day staking period is legal — it is not the price window", () => {
    expect(validateMarketTiming({ ...base, openFor: 604_800, windowFor: 86_400 }).ok).toBe(true);
  });
});

describe("validateMarketTiming — event markets", () => {
  it("accepts a 24-hour window like price markets", () => {
    expect(validateMarketTiming({ ...base, ruleKind: "EVENT_CLAIM", openFor: 3600, windowFor: 86_400 }).ok).toBe(true);
  });
  it("still rejects a window beyond the contract's one-year bound", () => {
    expect(validateMarketTiming({ ...base, ruleKind: "EVENT_CLAIM", openFor: 3600, windowFor: MAX_MARKET_WINDOW_SECONDS + 1 }).ok).toBe(false);
  });
});

describe("describeDuration", () => {
  it("renders the contract cap as 24 hours, longer spans in days", () => {
    expect(describeDuration(MAX_PRICE_RESOLUTION_WINDOW_SECONDS)).toBe("24 hours");
    expect(describeDuration(3 * 86_400)).toBe("3 days");
    expect(describeDuration(3600)).toBe("1 hour");
    expect(describeDuration(43_200)).toBe("12 hours");
  });
});
