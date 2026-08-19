/**
 * Shared StudioNet plumbing for the deploy and verification scripts.
 * One source of truth for the chain, the endpoint and the contract address.
 */

import "dotenv/config";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { privateKeyToAccount } from "viem/accounts";
import { TransactionStatus } from "genlayer-js/types";

export const STUDIO_URL =
  process.env.GENLAYER_RPC_URL ?? "https://studio.genlayer.com/api";

export const CHAIN_ID = 61999;

export function contractAddress(): `0x${string}` {
  const addr = process.env.AGENTBET_ADDRESS ?? process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;
  if (!addr) {
    console.error("AGENTBET_ADDRESS is not set (deploy first, or export it).");
    process.exit(1);
  }
  return addr as `0x${string}`;
}

export function account(envName: string) {
  const key = process.env[envName];
  if (!key || !key.startsWith("0x")) {
    console.error(`${envName} is missing from the environment.`);
    process.exit(1);
  }
  return privateKeyToAccount(key as `0x${string}`);
}

export function signer(envName: string) {
  return createClient({
    chain: studionet,
    account: account(envName),
    endpoint: STUDIO_URL,
  } as any);
}

export function reader() {
  return createClient({ chain: studionet, endpoint: STUDIO_URL } as any);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function balanceOf(address: string): Promise<bigint> {
  const res = await fetch(STUDIO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_getBalance",
      params: [address, "latest"],
    }),
  }).then((r) => r.json());
  return BigInt(res.result ?? "0x0");
}

/**
 * Submit a write and settle by STATE POLLING rather than trusting the receipt
 * waiter alone: StudioNet's waiter intermittently reports a fetch failure for a
 * transaction that in fact landed. `settled` returns true once the expected
 * state change is visible on-chain.
 */
export async function writeAndSettle(
  client: any,
  label: string,
  fn: string,
  args: any[],
  value: bigint,
  settled: () => Promise<boolean>,
  timeoutMs = 600_000,
): Promise<`0x${string}`> {
  const address = contractAddress();
  const hash = (await client.writeContract({
    address, functionName: fn, args, value,
  })) as `0x${string}`;
  console.log(`  tx ${label}: ${hash}`);
  const started = Date.now();
  try {
    await client.waitForTransactionReceipt({
      hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 14,
    });
  } catch {
    /* fall through to state polling */
  }
  while (Date.now() - started < timeoutMs) {
    try {
      if (await settled()) {
        console.log(`  ok ${label}`);
        return hash;
      }
    } catch {
      /* transient read failure */
    }
    await sleep(6_000);
  }
  throw new Error(`[${label}] state never settled within ${timeoutMs / 1000}s`);
}

/** Expect an on-chain revert: the guarded state must be unchanged afterwards. */
export async function expectRevert(
  client: any,
  label: string,
  fn: string,
  args: any[],
  value: bigint,
  unchanged: () => Promise<boolean>,
): Promise<boolean> {
  const address = contractAddress();
  const hash = (await client.writeContract({
    address, functionName: fn, args, value,
  })) as `0x${string}`;
  console.log(`  tx ${label}: ${hash}`);
  try {
    const r: any = await client.waitForTransactionReceipt({
      hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 24,
    });
    const exec = String(r?.txExecutionResultName ?? r?.txExecutionResult ?? "");
    if (exec.toUpperCase().includes("ERROR")) return true;
  } catch {
    /* decide from state below */
  }
  await sleep(10_000);
  return unchanged();
}

export async function read(fn: string, args: any[] = []) {
  return reader().readContract({
    address: contractAddress(), functionName: fn, args,
  });
}

export function sep(title: string) {
  console.log(`\n${"-".repeat(66)}\n  ${title}\n${"-".repeat(66)}`);
}

export const GEN = 1_000_000_000_000_000_000n;
