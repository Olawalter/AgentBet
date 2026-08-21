/**
 * The transaction driver, kept free of React so it can be tested in plain
 * Node. `useTx` is a thin hook over `runTransaction`.
 *
 * Two rules are enforced here rather than left to each page:
 *
 *  1. `finalized` is only reported after the write actually finalized AND the
 *     receipt carried no execution error — the contract layer throws on a
 *     reverted-but-finalized receipt, so a rejected write lands in `failed`.
 *
 *  2. Contract state is re-read after EVERY outcome, success or failure. A
 *     late resolve that the contract rejected because the deadline passed must
 *     leave the page showing "Resolution closed", not a stale button under an
 *     error toast. The `refresh` callback is the page's re-read.
 */

import type { TxState } from "./types";
import type { WriteHooks } from "./contract";
import { WrongNetworkError } from "./network";

export type Runner = (hooks: WriteHooks) => Promise<string>;
export type Emit = (next: TxState | ((prev: TxState) => TxState)) => void;

export type WriteErrorKind =
  | "wrong_network"
  | "user_rejected"
  | "insufficient_funds"
  | "resolution_closed"
  | "resolution_not_open"
  | "staking_closed"
  | "contract_rejected"
  | "unknown";

export interface ClassifiedError {
  kind: WriteErrorKind;
  message: string;
}

/** Stable substrings of the contract's own revert messages. Keep these in
 * step with contracts/agentbet.py — the tests assert each mapping. */
const CONTRACT_PATTERNS: ReadonlyArray<[RegExp, WriteErrorKind, string]> = [
  [
    /resolution deadline has passed/i,
    "resolution_closed",
    "The resolution window has expired — this market can no longer be resolved. " +
      "Once the recovery deadline passes, any participant can open refunds.",
  ],
  [
    /resolution window has not opened/i,
    "resolution_not_open",
    "Resolution has not opened yet — the observation instant has not been reached.",
  ],
  [
    /staking window has closed|not open for staking/i,
    "staking_closed",
    "Staking has closed for this market.",
  ],
];

export function classifyWriteError(err: unknown): ClassifiedError {
  const e = err as (Error & { code?: number }) | undefined;
  const message = e?.message ?? "Transaction failed.";

  if (err instanceof WrongNetworkError) {
    return { kind: "wrong_network", message };
  }
  if (e?.code === 4001 || /user rejected|user denied|denied transaction/i.test(message)) {
    return { kind: "user_rejected", message: "You rejected the transaction in your wallet." };
  }
  if (/insufficient funds/i.test(message)) {
    return { kind: "insufficient_funds", message: "Insufficient GEN balance for this transaction." };
  }
  for (const [pattern, kind, friendly] of CONTRACT_PATTERNS) {
    if (pattern.test(message)) return { kind, message: friendly };
  }
  if (message && message !== "Transaction failed.") {
    return { kind: "contract_rejected", message };
  }
  return { kind: "unknown", message };
}

export interface RunOptions {
  /** Runs only after a successful, finalized write (e.g. navigate away). */
  after?: () => Promise<void> | void;
  /** Runs after EVERY outcome — success or failure. Pages pass their contract
   * re-read here so the UI reflects authoritative state either way. */
  refresh?: () => Promise<void> | void;
}

export async function runTransaction(
  runner: Runner,
  emit: Emit,
  opts: RunOptions = {},
): Promise<boolean> {
  emit({ phase: "awaiting_wallet", note: "Confirm in your wallet" });
  let ok = false;
  try {
    await runner({
      onSubmitted: (hash) =>
        emit({ phase: "submitted", hash, note: "Submitted to StudioNet" }),
      onPending: () =>
        emit((s) => ({
          ...s,
          phase: "pending",
          note: "Awaiting validator consensus and finalization",
        })),
    });
    emit((s) => ({ ...s, phase: "finalized", note: "Finalized on-chain" }));
    ok = true;
  } catch (err: unknown) {
    const classified = classifyWriteError(err);
    emit((s) => ({ ...s, phase: "failed", error: classified.message, errorKind: classified.kind }));
  }

  if (ok && opts.after) {
    try {
      await opts.after();
    } catch {
      /* navigation/after-hooks must not turn a finalized write into an error */
    }
  }
  if (opts.refresh) {
    try {
      await opts.refresh();
    } catch {
      /* a failed re-read leaves the previous state; the page will retry */
    }
  }
  return ok;
}
