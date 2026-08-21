"use client";

import { useCallback, useState } from "react";
import type { TxState } from "./types";
import { classifyWriteError, runTransaction, type RunOptions, type Runner } from "./tx";

/**
 * React binding over `runTransaction` (see tx.ts for the rules it enforces).
 *
 * `fail(err)` lets a page record a client-side refusal — for example a final
 * pre-submit deadline check that found the window already closed — in the same
 * visual state as an on-chain rejection, without sending a transaction the
 * contract would reject anyway.
 */
export function useTx() {
  const [tx, setTx] = useState<TxState>({ phase: "idle" });

  const reset = useCallback(() => setTx({ phase: "idle" }), []);

  const run = useCallback(
    (runner: Runner, opts?: RunOptions) => runTransaction(runner, setTx, opts),
    [],
  );

  const fail = useCallback((err: unknown) => {
    const c = classifyWriteError(err);
    setTx({ phase: "failed", error: c.message, errorKind: c.kind });
  }, []);

  return { tx, run, reset, fail };
}
