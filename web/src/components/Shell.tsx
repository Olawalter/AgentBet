"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@/lib/wallet";
import { CHAIN_ID, CHAIN_NAME, CONTRACT_ADDRESS, explorerAddress } from "@/lib/network";
import { shortAddress } from "@/lib/format";
import { Wordmark } from "./Logo";
import { Button } from "./ui";

const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/markets/new", label: "Create" },
  { href: "/positions", label: "Positions" },
];

/**
 * Sits above every page. If the wallet is on the wrong chain the user learns it
 * HERE — before filling in a form — rather than at signature time via an opaque
 * RPC error.
 */
export function NetworkBanner() {
  const { wrongNetwork, chainId, switchNetwork, error } = useWallet();
  if (!wrongNetwork && !error) return null;

  return (
    <div className="border-b border-no/30 bg-no/10">
      <div className="mx-auto max-w-[1180px] px-5 py-2.5 flex items-center justify-between gap-4">
        <p className="text-[12px] text-bone">
          {wrongNetwork ? (
            <>
              <span className="text-no font-medium">Wrong network.</span>{" "}
              Your wallet is on chain {chainId ?? "?"}. AgentBet settles on{" "}
              {CHAIN_NAME} (chain {CHAIN_ID}).
            </>
          ) : (
            error
          )}
        </p>
        {wrongNetwork && (
          <button
            onClick={() => void switchNetwork()}
            className="text-[12px] border border-no/50 text-no px-3 h-8 hover:bg-no/15 shrink-0"
          >
            Switch to {CHAIN_NAME}
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectButton() {
  const { address, connect, connecting, hasWallet, wrongNetwork, switchNetwork } = useWallet();

  if (!hasWallet) {
    return (
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[12px] border border-ink-line text-bone-dim px-3 h-9 inline-flex items-center hover:text-bone"
      >
        Install wallet
      </a>
    );
  }
  if (!address) {
    return (
      <Button onClick={() => void connect()} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect wallet"}
      </Button>
    );
  }
  if (wrongNetwork) {
    return (
      <button
        onClick={() => void switchNetwork()}
        className="text-[12px] border border-no/50 text-no px-3 h-9 inline-flex items-center gap-2"
      >
        <span className="h-1.5 w-1.5 bg-no" /> Wrong network
      </button>
    );
  }
  return (
    <span className="text-[12px] font-mono border border-ink-line text-bone-dim px-3 h-9 inline-flex items-center gap-2">
      <span className="h-1.5 w-1.5 bg-yes" />
      {shortAddress(address)}
    </span>
  );
}

export function TopBar() {
  const pathname = usePathname();
  return (
    <header className="border-b border-ink-line bg-ink/95 backdrop-blur sticky top-0 z-30">
      <div className="mx-auto max-w-[1180px] px-5 h-14 flex items-center justify-between gap-6">
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>
        <nav className="hidden sm:flex items-center gap-1 flex-1">
          {NAV.map((n) => {
            const active = pathname === n.href || (n.href !== "/markets/new" && pathname.startsWith(n.href));
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 h-9 inline-flex items-center text-[13px] border-b-2 -mb-px transition-colors ${
                  active
                    ? "text-bone border-amber"
                    : "text-bone-faint border-transparent hover:text-bone-dim"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-ink-line mt-10">
      <div className="mx-auto max-w-[1180px] px-5 py-6 flex flex-col sm:flex-row gap-4 justify-between text-[11px] text-bone-faint">
        <p>
          Settlement is performed by the AgentBet Intelligent Contract on{" "}
          {CHAIN_NAME}. This interface only displays contract state.
        </p>
        {CONTRACT_ADDRESS && (
          <a
            className="link-amber font-mono"
            href={explorerAddress(CONTRACT_ADDRESS)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {shortAddress(CONTRACT_ADDRESS, 6)}
          </a>
        )}
      </div>
    </footer>
  );
}
