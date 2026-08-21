/**
 * Where a market sits on its timeline, computed from contract state.
 *
 * Mirrors the contract's own regimes exactly (contracts/agentbet.py,
 * resolve_market / mark_unresolved):
 *
 *   now <  resolution_start                       → not_open    (staking)
 *   resolution_start <= now <= resolution_deadline → open        (resolve legal)
 *   resolution_deadline <  now <= recovery_deadline → closed     (nothing legal)
 *   now >  recovery_deadline                      → recoverable (mark_unresolved legal)
 *
 * The `open` boundary is INCLUSIVE at the deadline because the contract's
 * guard is `now <= resolution_deadline`. This module deliberately does not
 * invent a stricter (or looser) deadline than the contract — the UI mirrors the
 * authority, and the contract re-checks with its own consensus clock anyway.
 *
 * Pure functions: no React, no wall clock of their own. Callers pass `nowSec`.
 */

import type { MarketStatus } from "./types";

export type ResolutionWindowState =
  | "not_open"
  | "open"
  | "closed"
  | "recoverable"
  | "terminal";

export interface ResolutionWindow {
  state: ResolutionWindowState;
  /** Observation instant / staking close (epoch seconds). */
  opensAt: number;
  /** Last second resolve_market is accepted (epoch seconds, inclusive). */
  closesAt: number;
  /** First second after which any participant may open refunds. */
  recoveryAt: number;
  /** Seconds until the window closes while open; 0 otherwise. */
  secondsLeft: number;
}

export interface TimelineFields {
  status: MarketStatus | string;
  resolution_start: string | number;
  resolution_deadline: string | number;
  recovery_deadline: string | number;
}

const LIVE: ReadonlySet<string> = new Set(["open", "closed"]);

export function resolutionWindow(m: TimelineFields, nowSec: number): ResolutionWindow {
  const opensAt = Number(m.resolution_start);
  const closesAt = Number(m.resolution_deadline);
  const recoveryAt = Number(m.recovery_deadline);

  if (!LIVE.has(String(m.status))) {
    return { state: "terminal", opensAt, closesAt, recoveryAt, secondsLeft: 0 };
  }
  if (nowSec < opensAt) {
    return { state: "not_open", opensAt, closesAt, recoveryAt, secondsLeft: 0 };
  }
  if (nowSec <= closesAt) {
    return { state: "open", opensAt, closesAt, recoveryAt, secondsLeft: closesAt - nowSec };
  }
  if (nowSec <= recoveryAt) {
    return { state: "closed", opensAt, closesAt, recoveryAt, secondsLeft: 0 };
  }
  return { state: "recoverable", opensAt, closesAt, recoveryAt, secondsLeft: 0 };
}

/** True only while the contract would accept resolve_market. */
export function canResolve(m: TimelineFields, nowSec: number): boolean {
  return resolutionWindow(m, nowSec).state === "open";
}

/** True only while the contract would accept mark_unresolved. */
export function canRecover(m: TimelineFields, nowSec: number): boolean {
  return resolutionWindow(m, nowSec).state === "recoverable";
}

/** True while the contract would accept stake / close_market relative to the
 * instant (status is checked separately by the caller). */
export function stakingOpen(m: TimelineFields, nowSec: number): boolean {
  return nowSec < Number(m.resolution_start);
}
