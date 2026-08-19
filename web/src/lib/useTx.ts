"use client";

import { useCallback, useState } from "react";
import type { TxState } from "./types";
import type { WriteHooks } from "./contract";
import { WrongNetworkError } from "./network";

type Runner = (hooks: WriteHooks) => Promise<string>;

/**
 * Drives one write through its real lifecycle and refuses to shortcut it.
 *
 * `submitted` and `finalized` are different states and the UI shows them as
 * different states: a submitted transaction has moved no value. The optional
 * `after` callback runs only once the transaction is FINALIZED, and is where
 * callers re-read contract state — the UI never assumes what the write did.
 */
export function useTx() {
  const [tx, setTx] = useState<TxState>({ phase: "idle" });

  const reset = useCallback(() => setTx({ phase: "idle" }), []);

  const run = useCallback(
    async (runner: Runner, after?: () => Promise<void> | void) => {
      setTx({ phase: "awaiting_wallet", note: "Confirm in your wallet" });
      try {
        await runner({
          onSubmitted: (hash) =>
            setTx({ phase: "submitted", hash, note: "Submitted to StudioNet" }),
          onPending: () =>
            setTx((s) => ({
              ...s,
              phase: "pending",
              note: "Awaiting validator consensus and finalization",
            })),
        });
        setTx((s) => ({ ...s, phase: "finalized", note: "Finalized on-chain" }));
        if (after) await after();
        return true;
      } catch (e: unknown) {
        const err = e as Error & { code?: number };
        let message = err?.message ?? "Transaction failed.";
        if (err instanceof WrongNetworkError) {
          message = err.message;
        } else if (err?.code === 4001 || /user rejected|denied/i.test(message)) {
          message = "You rejected the transaction in your wallet.";
        } else if (/insufficient funds/i.test(message)) {
          message = "Insufficient GEN balance for this stake.";
        }
        setTx((s) => ({ ...s, phase: "failed", error: message }));
        return false;
      }
    },
    [],
  );

  return { tx, run, reset };
}
