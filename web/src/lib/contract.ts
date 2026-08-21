/**
 * Every contract interaction. Reads go through a keyless client so browsing
 * works on any wallet network; writes go through the connected wallet and are
 * gated by ensureActiveChain().
 *
 * Two rules this module enforces on behalf of the whole app:
 *   1. no write is ever built before the wallet is confirmed on StudioNet;
 *   2. a FINALIZED receipt is inspected for an execution error before it is
 *      reported as success — GenLayer finalizes reverted transactions too, and
 *      treating that as success shows the user a green tick over a state change
 *      that never happened.
 */

import { createClient } from "genlayer-js";
import { TransactionStatus } from "genlayer-js/types";
import {
  CHAIN, RPC_URL, CONTRACT_ADDRESS, ensureActiveChain,
} from "./network";
import type {
  Market, MarketPage, Position, Claimable, Resolution, AgentStats, Config,
} from "./types";

function readClient() {
  return createClient({ chain: CHAIN, endpoint: RPC_URL } as never);
}

function writeClient(account: `0x${string}`) {
  return createClient({ chain: CHAIN, account, endpoint: RPC_URL } as never);
}

function requireAddress(): `0x${string}` {
  if (!CONTRACT_ADDRESS) {
    throw new Error(
      "NEXT_PUBLIC_CONTRACT_ADDRESS is not configured for this deployment.",
    );
  }
  return CONTRACT_ADDRESS;
}

async function read<T>(functionName: string, args: unknown[] = []): Promise<T> {
  const client = readClient();
  return (await client.readContract({
    address: requireAddress(),
    functionName,
    args: args as never,
  })) as T;
}

/**
 * Pull a human-readable reason out of a reverted receipt, or null if the
 * transaction actually succeeded.
 *
 * GenLayer FINALIZES reverted transactions, so "finalized" is not "succeeded".
 * Getting this wrong is the difference between telling a user their resolution
 * landed and telling them the window expired.
 *
 * Where the verdict actually lives (verified against a real reverted StudioNet
 * transaction, 0x110977b1…8188):
 *
 *   consensus_data.leader_receipt[0].execution_result === "ERROR"
 *   consensus_data.leader_receipt[0].result === {
 *     status: "rollback",
 *     payload: "[EXPECTED] this position has already been settled",
 *   }
 *
 * The top-level camelCase fields (`txExecutionResultName`, `txExecutionResult`)
 * and the `messages[]` array are populated only on the non-studio decode path —
 * on StudioNet they are undefined and an empty array, so reading only those
 * reports every revert as a success. They are kept below as a secondary signal
 * for other networks.
 */
export function revertReason(receipt: unknown): string | null {
  const r = (receipt ?? {}) as Record<string, unknown>;

  const leaderField = (r.consensus_data as Record<string, unknown> | undefined)
    ?.leader_receipt;
  const leader = (Array.isArray(leaderField) ? leaderField[0] : leaderField) as
    | Record<string, unknown>
    | undefined;

  const leaderExec = String(leader?.execution_result ?? "").toUpperCase();
  const legacyExec = String(
    (r.txExecutionResultName as string) ?? (r.txExecutionResult as string) ?? "",
  ).toUpperCase();

  const result = leader?.result as Record<string, unknown> | undefined;
  const rolledBack = String(result?.status ?? "").toLowerCase() === "rollback";

  const failed =
    leaderExec.includes("ERROR") || legacyExec.includes("ERROR") || rolledBack;
  if (!failed) return null;

  // Prefer the contract's own guard message, then the runtime's error text,
  // then the legacy messages[] array.
  const genvm = leader?.genvm_result as Record<string, unknown> | undefined;
  const messages = (r.messages as Array<Record<string, string>> | undefined) ?? [];
  const legacy = messages.find((m) => m?.errorMessage || m?.message);

  const raw =
    (typeof result?.payload === "string" ? result.payload : "") ||
    (typeof genvm?.error_description === "string" ? genvm.error_description : "") ||
    (typeof genvm?.stderr === "string" ? genvm.stderr : "") ||
    legacy?.errorMessage ||
    legacy?.message ||
    "";

  // Contract guards carry a stable [EXPECTED] / [TRANSIENT] prefix.
  const cleaned = String(raw)
    .replace(/^\[(EXPECTED|TRANSIENT|EXTERNAL|LLM_ERROR)\]\s*/, "")
    .trim();
  return cleaned || "The contract rejected this transaction.";
}

export interface WriteHooks {
  onSubmitted?: (hash: string) => void;
  onPending?: () => void;
}

async function write(
  account: `0x${string}`,
  functionName: string,
  args: unknown[],
  value: bigint,
  hooks?: WriteHooks,
): Promise<string> {
  // Reconcile the wallet BEFORE building the transaction. Skipping this is what
  // produces "chainId should be same as current chainId" at submit time.
  await ensureActiveChain();

  const client = writeClient(account);
  // Keep the client's own hash type rather than casting through string: the SDK
  // brands it, and a cast here is what turns a type error into a runtime one.
  const hash = await client.writeContract({
    address: requireAddress(),
    functionName,
    args: args as never,
    value,
  });
  hooks?.onSubmitted?.(String(hash));
  hooks?.onPending?.();

  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    interval: 5_000,
    retries: 120,
  });

  const reason = revertReason(receipt);
  if (reason) throw new Error(reason);
  return String(hash);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const getConfig = () => read<Config>("get_config");
export const getMarket = (id: string) => read<Market>("get_market", [id]);
export const listMarkets = (offset = 0, limit = 50) =>
  read<MarketPage>("list_markets", [offset, limit]);
export const getPosition = (id: string, who: string) =>
  read<Position>("get_position", [id, who]);
export const getClaimable = (id: string, who: string) =>
  read<Claimable>("get_claimable", [id, who]);
export const getResolution = (id: string) =>
  read<Resolution>("get_resolution", [id]);
export const getAgent = (who: string) => read<AgentStats>("get_agent", [who]);
export const getUserMarkets = (who: string) =>
  read<string[]>("get_user_markets", [who]);

// ── Writes ───────────────────────────────────────────────────────────────────

export function createMarket(
  account: `0x${string}`,
  m: {
    question: string;
    description: string;
    ruleKind: string;
    subject: string;
    comparator: string;
    thresholdCents: number;
    conditionText: string;
    resolutionStart: number;
    resolutionDeadline: number;
    claimSources: string[];
  },
  hooks?: WriteHooks,
) {
  return write(
    account,
    "create_market",
    [
      m.question, m.description, m.ruleKind, m.subject, m.comparator,
      m.thresholdCents, m.conditionText, m.resolutionStart,
      m.resolutionDeadline, m.claimSources,
    ],
    0n,
    hooks,
  );
}

export function stake(
  account: `0x${string}`,
  marketId: string,
  side: "YES" | "NO",
  amountWei: bigint,
  hooks?: WriteHooks,
) {
  return write(account, "stake", [marketId, side], amountWei, hooks);
}

export function closeMarket(account: `0x${string}`, id: string, hooks?: WriteHooks) {
  return write(account, "close_market", [id], 0n, hooks);
}

export function resolveMarket(account: `0x${string}`, id: string, hooks?: WriteHooks) {
  return write(account, "resolve_market", [id], 0n, hooks);
}

export function claimWinnings(account: `0x${string}`, id: string, hooks?: WriteHooks) {
  return write(account, "claim_winnings", [id], 0n, hooks);
}

export function claimRefund(account: `0x${string}`, id: string, hooks?: WriteHooks) {
  return write(account, "claim_refund", [id], 0n, hooks);
}

export function markUnresolved(account: `0x${string}`, id: string, hooks?: WriteHooks) {
  return write(account, "mark_unresolved", [id], 0n, hooks);
}

export function cancelMarket(account: `0x${string}`, id: string, hooks?: WriteHooks) {
  return write(account, "cancel_market", [id], 0n, hooks);
}
