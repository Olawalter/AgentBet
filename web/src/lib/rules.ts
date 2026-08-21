/**
 * Market-timing rules as the CONTRACT defines them.
 *
 * The contract is the authority: every guard below exists on-chain and the
 * contract will reject a transaction that breaks it regardless of what this
 * file says. What this file does is let the UI refuse to OFFER a configuration
 * the contract would reject, and explain why, before a wallet is ever opened.
 *
 * Where a value is published by the contract (`get_config`) the pages read it
 * from there. Two caps are not published by the deployed contract, so they are
 * mirrored here — each one is pinned to the contract source by a test
 * (`rules.test.ts` reads `contracts/agentbet.py` and asserts equality), so the
 * mirror cannot silently diverge from the rule it mirrors.
 */

export type RuleKind = "SPOT_THRESHOLD" | "EVENT_CLAIM";

/**
 * Mirrors `MAX_PRICE_RESOLUTION_WINDOW` in contracts/agentbet.py.
 *
 * A price market's resolution deadline may be at most this long after its
 * observation instant (= `resolution_start`). The cap exists because the
 * historical candle the validators fetch must still be retrievable from at
 * least two independent operators for the whole window — the shortest
 * retention among the bound feeds is about a day.
 */
export const MAX_PRICE_RESOLUTION_WINDOW_SECONDS = 86_400;

/** Mirrors `MAX_MARKET_WINDOW` in contracts/agentbet.py (one year). Bounds
 * both how long staking may stay open and an event market's window. */
export const MAX_MARKET_WINDOW_SECONDS = 365 * 24 * 3600;

export interface DurationOption {
  label: string;
  seconds: number;
}

/**
 * How long the market accepts stakes before the observation instant. This is
 * the stake-accrual period — it is NOT the price observation window, and the
 * contract bounds it only by MAX_MARKET_WINDOW. A week of staking ahead of a
 * predetermined instant is a perfectly ordinary market, so it stays offered.
 */
export const STAKING_OPEN_OPTIONS: readonly DurationOption[] = [
  { label: "1 hour", seconds: 3_600 },
  { label: "6 hours", seconds: 21_600 },
  { label: "24 hours", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
];

/**
 * How long after the observation instant resolution may still be run. Every
 * option sits inside the contract's one-day cap for price markets, so nothing
 * offered here can be rejected on-chain for length. Event markets could legally
 * run longer, but one consistent set keeps the rule obvious: the window is at
 * most 24 hours.
 */
export const RESOLUTION_WINDOW_OPTIONS: readonly DurationOption[] = [
  { label: "1 hour", seconds: 3_600 },
  { label: "6 hours", seconds: 21_600 },
  { label: "12 hours", seconds: 43_200 },
  { label: "24 hours", seconds: 86_400 },
];

export interface TimingInput {
  /** Current wall-clock epoch seconds (the caller's clock; the contract uses
   * its own consensus clock and re-checks every bound). */
  nowSec: number;
  /** Seconds from now until the observation instant / staking close. */
  openFor: number;
  /** Seconds from the observation instant until the resolution deadline. */
  windowFor: number;
  ruleKind: RuleKind;
  /** `min_market_window` as published by the contract's get_config. */
  minMarketWindow: number;
}

export interface TimingResult {
  ok: boolean;
  errors: string[];
  /** The instant the price is observed at and staking closes. */
  resolutionStart: number;
  /** Last second at which resolve_market is accepted (inclusive). */
  resolutionDeadline: number;
}

function isWholeSeconds(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n);
}

/**
 * Validate a proposed market's timing exactly as the contract will. Invalid
 * input is rejected with a reason — never silently clamped — so a user who
 * picks something the contract forbids is told why rather than having the
 * request quietly rewritten underneath them.
 */
export function validateMarketTiming(input: TimingInput): TimingResult {
  const errors: string[] = [];
  const { nowSec, openFor, windowFor, ruleKind, minMarketWindow } = input;

  if (!isWholeSeconds(nowSec) || nowSec <= 0) {
    errors.push("Clock unavailable — cannot compute the market's timing.");
  }
  if (!isWholeSeconds(openFor)) {
    errors.push("Staking duration must be a whole number of seconds.");
  } else if (openFor <= 0) {
    errors.push("Staking duration must be positive.");
  } else if (openFor < minMarketWindow) {
    errors.push(
      `The market must stay open for at least ${minMarketWindow} seconds before the observation instant.`,
    );
  } else if (openFor > MAX_MARKET_WINDOW_SECONDS) {
    errors.push("Staking may stay open for at most one year.");
  }

  if (!isWholeSeconds(windowFor)) {
    errors.push("Resolution window must be a whole number of seconds.");
  } else if (windowFor <= 0) {
    errors.push("The resolution deadline must come after the observation instant.");
  } else if (windowFor > MAX_MARKET_WINDOW_SECONDS) {
    errors.push("The resolution window may be at most one year.");
  } else if (ruleKind === "SPOT_THRESHOLD" && windowFor > MAX_PRICE_RESOLUTION_WINDOW_SECONDS) {
    errors.push(
      `Price markets may resolve at most ${MAX_PRICE_RESOLUTION_WINDOW_SECONDS / 3600} hours ` +
        "after the observation instant — the contract rejects longer windows.",
    );
  }

  const resolutionStart = errors.length ? 0 : nowSec + openFor;
  const resolutionDeadline = errors.length ? 0 : resolutionStart + windowFor;

  return { ok: errors.length === 0, errors, resolutionStart, resolutionDeadline };
}

/** Human label for a window length, used in helper text. Up to a day is
 * spoken in hours ("24 hours"), longer spans in days ("3 days"). */
export function describeDuration(seconds: number): string {
  if (seconds >= 2 * 86_400 && seconds % 86_400 === 0) {
    return `${seconds / 86_400} days`;
  }
  if (seconds % 3_600 === 0) {
    const h = seconds / 3_600;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}
