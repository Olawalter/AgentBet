/**
 * Receipt decoding — the step that turns a reverted-but-finalized transaction
 * into a thrown error. If this returns null for a revert, every downstream
 * guarantee collapses: the UI reports "Finalized on-chain" for a write the
 * contract rejected.
 *
 * The fixtures below are the SHAPES OBSERVED ON STUDIONET, captured from real
 * transactions on the deployed contract — not invented.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { revertReason } from "../contract";

/** Real reverted transaction 0x110977b1…8188 (a second claim), as
 * `waitForTransactionReceipt` returns it for a studio chain. */
const REVERTED_STUDIONET = {
  status: "FINALIZED",
  // Note: the camelCase fields the old implementation relied on are absent,
  // and messages is empty — that was the bug.
  messages: [],
  consensus_data: {
    leader_receipt: [
      {
        execution_result: "ERROR",
        mode: "leader",
        vote: null,
        genvm_result: { stderr: "", stdout: "", raw_error: null, error_code: null, error_description: null },
        result: {
          status: "rollback",
          payload: "[EXPECTED] this position has already been settled",
        },
      },
    ],
  },
};

/** A successful transaction on the same path. */
const SUCCESS_STUDIONET = {
  status: "FINALIZED",
  messages: [],
  consensus_data: {
    leader_receipt: [
      {
        execution_result: "SUCCESS",
        mode: "leader",
        genvm_result: { stderr: "", stdout: "", raw_error: null },
        result: { status: "return", payload: null },
      },
    ],
  },
};

describe("revertReason on real StudioNet receipt shapes", () => {
  it("detects a reverted transaction that GenLayer nonetheless FINALIZED", () => {
    expect(revertReason(REVERTED_STUDIONET)).not.toBeNull();
  });

  it("returns the contract's own guard message, with the [EXPECTED] prefix stripped", () => {
    expect(revertReason(REVERTED_STUDIONET)).toBe("this position has already been settled");
  });

  it("returns null for a successful transaction — success is never reported as a revert", () => {
    expect(revertReason(SUCCESS_STUDIONET)).toBeNull();
  });

  it("REGRESSION: the old field-set alone would have missed this revert", () => {
    // The precise failure this test exists to prevent: reading only the
    // camelCase fields / messages[] yields "no error" for a real revert.
    const oldImplementationWouldSee = String(
      (REVERTED_STUDIONET as Record<string, unknown>).txExecutionResultName ??
        (REVERTED_STUDIONET as Record<string, unknown>).txExecutionResult ??
        "",
    ).toUpperCase();
    expect(oldImplementationWouldSee).toBe("");
    expect(REVERTED_STUDIONET.messages).toHaveLength(0);
    // ...while the corrected implementation catches it.
    expect(revertReason(REVERTED_STUDIONET)).toBeTruthy();
  });

  it("carries the resolve-after-deadline message through verbatim", () => {
    const receipt = {
      consensus_data: {
        leader_receipt: [{
          execution_result: "ERROR",
          result: {
            status: "rollback",
            payload:
              "[EXPECTED] the resolution deadline has passed — this market can only be recovered for refunds now (mark_unresolved after the recovery deadline)",
          },
        }],
      },
    };
    const reason = revertReason(receipt);
    expect(reason).toMatch(/resolution deadline has passed/);
    expect(reason).not.toMatch(/^\[EXPECTED\]/);
  });
});

describe("revertReason tolerates the other shapes it may be handed", () => {
  it("accepts leader_receipt as a bare object rather than an array", () => {
    const receipt = {
      consensus_data: {
        leader_receipt: {
          execution_result: "ERROR",
          result: { status: "rollback", payload: "[EXPECTED] nope" },
        },
      },
    };
    expect(revertReason(receipt)).toBe("nope");
  });

  it("still honours the legacy non-studio fields", () => {
    const receipt = {
      txExecutionResultName: "ERROR",
      messages: [{ errorMessage: "[EXPECTED] legacy path message" }],
    };
    expect(revertReason(receipt)).toBe("legacy path message");
  });

  it("treats a rollback status as a revert even if execution_result is missing", () => {
    const receipt = {
      consensus_data: { leader_receipt: [{ result: { status: "rollback", payload: "boom" } }] },
    };
    expect(revertReason(receipt)).toBe("boom");
  });

  it("falls back to a generic message when the payload is empty", () => {
    const receipt = {
      consensus_data: { leader_receipt: [{ execution_result: "ERROR", result: { status: "rollback" } }] },
    };
    expect(revertReason(receipt)).toBe("The contract rejected this transaction.");
  });

  it("uses genvm error text when there is no rollback payload", () => {
    const receipt = {
      consensus_data: {
        leader_receipt: [{
          execution_result: "ERROR",
          genvm_result: { error_description: "[TRANSIENT] node unavailable", stderr: "" },
        }],
      },
    };
    expect(revertReason(receipt)).toBe("node unavailable");
  });

  it("does not crash on empty, null or malformed receipts", () => {
    expect(revertReason(undefined)).toBeNull();
    expect(revertReason(null)).toBeNull();
    expect(revertReason({})).toBeNull();
    expect(revertReason({ consensus_data: {} })).toBeNull();
    expect(revertReason({ consensus_data: { leader_receipt: [] } })).toBeNull();
  });
});

describe("the classified revert strings are pinned to the contract source", () => {
  const CONTRACT = fs.readFileSync(
    path.resolve(__dirname, "../../../../contracts/agentbet.py"),
    "utf-8",
  );

  it("resolve_market still reverts with the phrase tx.ts classifies", () => {
    // If someone rewords the contract guard, this fails here rather than
    // silently degrading the race-handling message in production.
    expect(CONTRACT).toMatch(/the resolution deadline has passed/);
    expect(CONTRACT).toMatch(/the resolution window has not opened yet/);
  });

  it("stake still reverts with the staking-window phrase", () => {
    expect(CONTRACT).toMatch(/the staking window has closed/);
  });
});
