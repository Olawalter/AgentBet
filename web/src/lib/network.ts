/**
 * The single source of truth for the chain, the endpoint and the contract
 * address. Nothing else in the app is allowed to define a chain id or an RPC
 * URL — when those drift apart, transactions get rejected in ways that are very
 * hard to read from the error message.
 *
 * The guard below exists because of a specific, expensive failure: genlayer-js
 * stamps an explicit `chainId` into every eth_sendTransaction, and MetaMask
 * validates that against its CURRENTLY SELECTED network. If the user's wallet is
 * on any other chain, the wallet rejects the request with
 *
 *     "chainId should be same as current chainId"
 *
 * ...which reads like a bug in the app rather than "you are on the wrong
 * network". So every state-changing call reconciles the wallet FIRST.
 */

import { studionet } from "genlayer-js/chains";

export const CHAIN = studionet;
export const CHAIN_ID = 61999;
export const CHAIN_ID_HEX = "0x" + CHAIN_ID.toString(16); // 0xf22f
export const CHAIN_NAME = "GenLayer StudioNet";

export const RPC_URL =
  process.env.NEXT_PUBLIC_GENLAYER_RPC_URL ?? "https://studio.genlayer.com/api";

export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ??
  "") as `0x${string}`;

export const EXPLORER = "https://explorer-studio.genlayer.com";

export function explorerTx(hash: string) {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAddress(addr: string) {
  return `${EXPLORER}/address/${addr}`;
}

/** EIP-3085 parameters, derived from the same constants above. */
const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: CHAIN_NAME,
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
};

export class WrongNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongNetworkError";
  }
}

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth ?? null;
}

export async function currentChainId(): Promise<number | null> {
  const eth = injected();
  if (!eth) return null;
  try {
    const raw = (await eth.request({ method: "eth_chainId" })) as string;
    return parseInt(raw, 16);
  } catch {
    return null;
  }
}

/**
 * Reconcile the wallet to StudioNet, then RE-READ the chain to confirm it.
 *
 * The re-read is not paranoia: a wallet may resolve wallet_switchEthereumChain
 * without actually switching (user dismissed, multi-account edge cases). If we
 * trusted the switch call's own resolution we would go on to send a transaction
 * that the wallet then rejects with the confusing chainId error.
 *
 * Throws WrongNetworkError rather than returning false, so a caller cannot
 * accidentally continue on the wrong chain by ignoring a return value.
 */
export async function ensureActiveChain(): Promise<void> {
  const eth = injected();
  if (!eth) throw new WrongNetworkError("No wallet found. Install MetaMask to continue.");

  if ((await currentChainId()) === CHAIN_ID) return;

  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    // 4902: the wallet has never seen this chain, so add it and switch again.
    if (code === 4902) {
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [ADD_CHAIN_PARAMS],
        });
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: CHAIN_ID_HEX }],
        });
      } catch {
        throw new WrongNetworkError(
          `Could not add ${CHAIN_NAME} to your wallet. Add it manually (chain ${CHAIN_ID}) and try again.`,
        );
      }
    } else if (code === 4001) {
      throw new WrongNetworkError(
        `You declined the network switch. Switch to ${CHAIN_NAME} (chain ${CHAIN_ID}) to continue.`,
      );
    } else {
      throw new WrongNetworkError(
        `Could not switch to ${CHAIN_NAME}. Switch manually (chain ${CHAIN_ID}) and try again.`,
      );
    }
  }

  // Confirm from the wallet itself, never from the switch call's resolution.
  if ((await currentChainId()) !== CHAIN_ID) {
    throw new WrongNetworkError(
      `Your wallet is still not on ${CHAIN_NAME} (chain ${CHAIN_ID}). Switch networks and try again.`,
    );
  }
}
