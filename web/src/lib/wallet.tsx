"use client";

/**
 * Wallet connection and network state.
 *
 * The network half is deliberately prominent: the app tracks the wallet's chain
 * continuously, reconciles it on connect, and re-reads it on every
 * `chainChanged` event, so the UI can warn BEFORE a user fills in a form rather
 * than failing at signature time with an opaque RPC error.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from "react";
import {
  CHAIN_ID, CHAIN_NAME, currentChainId, ensureActiveChain, injected,
} from "./network";

interface WalletState {
  address: `0x${string}` | null;
  chainId: number | null;
  wrongNetwork: boolean;
  hasWallet: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState(false);

  useEffect(() => {
    setHasWallet(!!injected());
  }, []);

  const refreshChain = useCallback(async () => {
    setChainId(await currentChainId());
  }, []);

  // Restore an already-authorised account without prompting, and keep chain and
  // account state in sync with the wallet for the life of the page.
  useEffect(() => {
    const eth = injected();
    if (!eth) return;

    (async () => {
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        if (accounts?.length) setAddress(accounts[0] as `0x${string}`);
      } catch {
        /* wallet declined to enumerate; stay disconnected */
      }
      await refreshChain();
    })();

    const provider = eth as unknown as {
      on?: (e: string, cb: (...a: never[]) => void) => void;
      removeListener?: (e: string, cb: (...a: never[]) => void) => void;
    };
    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      setAddress(accounts?.length ? (accounts[0] as `0x${string}`) : null);
    };
    const onChain = () => {
      void refreshChain();
    };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [refreshChain]);

  const connect = useCallback(async () => {
    const eth = injected();
    if (!eth) {
      setError("No wallet detected. Install MetaMask to continue.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await eth.request({
        method: "eth_requestAccounts",
      })) as string[];
      setAddress(accounts?.[0] as `0x${string}`);
      // Reconcile immediately so the user is on the right chain before they
      // start filling in a stake or a market.
      try {
        await ensureActiveChain();
      } catch {
        /* the banner will prompt; connecting itself succeeded */
      }
      await refreshChain();
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      setError(code === 4001 ? "Connection request rejected." : "Could not connect to your wallet.");
    } finally {
      setConnecting(false);
    }
  }, [refreshChain]);

  const switchNetwork = useCallback(async () => {
    setError(null);
    try {
      await ensureActiveChain();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? `Switch to ${CHAIN_NAME} to continue.`);
    } finally {
      await refreshChain();
    }
  }, [refreshChain]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setError(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      chainId,
      wrongNetwork: !!address && chainId !== null && chainId !== CHAIN_ID,
      hasWallet,
      connecting,
      error,
      connect,
      disconnect,
      switchNetwork,
    }),
    [address, chainId, hasWallet, connecting, error, connect, disconnect, switchNetwork],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
