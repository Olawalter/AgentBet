"use client";

import Link from "next/link";
import type { MarketStatus, Outcome, TxState } from "@/lib/types";
import { explorerTx } from "@/lib/network";

export function Panel({
  children, className = "", tick = false,
}: { children: React.ReactNode; className?: string; tick?: boolean }) {
  return (
    <div className={`panel ${tick ? "panel-tick" : ""} ${className}`}>{children}</div>
  );
}

export function Label({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`label ${className}`}>{children}</div>;
}

export function Button({
  children, onClick, variant = "primary", disabled, type = "button", className = "", full,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "yes" | "no" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  full?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 px-4 h-10 text-[13px] font-medium tracking-tight border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  const styles = {
    primary: "bg-amber text-ink border-amber hover:bg-amber-soft hover:border-amber-soft",
    ghost: "bg-transparent text-bone-dim border-ink-line hover:text-bone hover:border-bone-faint",
    yes: "bg-transparent text-yes border-yes/40 hover:bg-yes/10 hover:border-yes",
    no: "bg-transparent text-no border-no/40 hover:bg-no/10 hover:border-no",
    danger: "bg-transparent text-no border-no/40 hover:bg-no/10",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles} ${full ? "w-full" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

const STATUS_STYLE: Record<MarketStatus, string> = {
  open: "text-amber border-amber/40",
  closed: "text-bone-dim border-ink-line",
  finalized: "text-yes border-yes/40",
  refundable: "text-bone-dim border-bone-faint/50",
  settled: "text-bone-faint border-ink-line",
  cancelled: "text-bone-faint border-ink-line",
};

const STATUS_TEXT: Record<MarketStatus, string> = {
  open: "OPEN",
  closed: "CLOSED",
  finalized: "FINALIZED",
  refundable: "REFUNDABLE",
  settled: "SETTLED",
  cancelled: "CANCELLED",
};

export function StatusPill({ status, outcome }: { status: MarketStatus; outcome?: Outcome }) {
  const showOutcome = !!outcome && (status === "finalized" || status === "settled");
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center h-[22px] px-2 border text-[10px] font-mono tracking-[0.14em] ${STATUS_STYLE[status]}`}
      >
        {status === "open" && <span className="mr-1.5 h-1.5 w-1.5 bg-amber pulse-dot" />}
        {STATUS_TEXT[status]}
      </span>
      {showOutcome && (
        <span
          className={`inline-flex items-center h-[22px] px-2 border text-[10px] font-mono tracking-[0.14em] ${
            outcome === "YES" ? "text-yes border-yes/40" :
            outcome === "NO" ? "text-no border-no/40" :
            "text-bone-dim border-bone-faint/50"
          }`}
        >
          {outcome}
        </span>
      )}
    </span>
  );
}

/** Stake distribution across the two sides. Describes what people staked; it is
 * not a probability the contract endorses and not a payout. */
export function PoolBar({ yes, no }: { yes: string; no: string }) {
  const y = BigInt(yes || "0");
  const n = BigInt(no || "0");
  const total = y + n;
  const yesPct = total === 0n ? 50 : Number((y * 10000n) / total) / 100;
  return (
    <div className="h-[6px] w-full bg-ink-line flex">
      <div className="bg-yes/70 h-full" style={{ width: `${yesPct}%` }} />
      <div className="bg-no/70 h-full" style={{ width: `${100 - yesPct}%` }} />
    </div>
  );
}

export function Stat({
  label, value, sub, accent,
}: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: "yes" | "no" | "amber" }) {
  const color =
    accent === "yes" ? "text-yes" : accent === "no" ? "text-no" : accent === "amber" ? "text-amber" : "text-bone";
  return (
    <div>
      <Label>{label}</Label>
      <div className={`tnum text-[15px] mt-1 ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-bone-faint mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * The transaction lifecycle, shown honestly. "Submitted" and "Finalized" are
 * separate rows because they are separate facts: a submitted transaction has
 * moved no value yet.
 */
export function TxStatus({ tx, onDismiss }: { tx: TxState; onDismiss?: () => void }) {
  if (tx.phase === "idle") return null;

  const steps = [
    { key: "awaiting_wallet", text: "Wallet confirmation" },
    { key: "submitted", text: "Submitted" },
    { key: "pending", text: "Validator consensus" },
    { key: "finalized", text: "Finalized on-chain" },
  ];
  const order = ["awaiting_wallet", "submitted", "pending", "finalized"];
  const current = order.indexOf(tx.phase);
  const failed = tx.phase === "failed";

  return (
    <Panel className="p-4 mt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label>{failed ? "Transaction failed" : "Transaction"}</Label>
          {failed ? (
            <p className="text-[13px] text-no mt-2 leading-relaxed">{tx.error}</p>
          ) : (
            <ol className="mt-2 space-y-1.5">
              {steps.map((s, i) => {
                const done = current > i;
                const active = current === i;
                return (
                  <li key={s.key} className="flex items-center gap-2 text-[12px]">
                    <span
                      className={`h-1.5 w-1.5 ${
                        done ? "bg-yes" : active ? "bg-amber pulse-dot" : "bg-ink-line"
                      }`}
                    />
                    <span className={done ? "text-bone-dim" : active ? "text-bone" : "text-bone-faint"}>
                      {s.text}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {tx.hash && (
            <a
              className="link-amber text-[11px] font-mono mt-2 inline-block"
              href={explorerTx(tx.hash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {tx.hash.slice(0, 18)}…
            </a>
          )}
        </div>
        {(failed || tx.phase === "finalized") && onDismiss && (
          <button onClick={onDismiss} className="label hover:text-bone">
            dismiss
          </button>
        )}
      </div>
    </Panel>
  );
}

export function Empty({ title, hint, cta }: { title: string; hint?: string; cta?: React.ReactNode }) {
  return (
    <Panel className="p-10 text-center">
      <p className="text-bone-dim text-[14px]">{title}</p>
      {hint && <p className="text-bone-faint text-[12px] mt-1.5">{hint}</p>}
      {cta && <div className="mt-5 flex justify-center">{cta}</div>}
    </Panel>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="label hover:text-bone inline-flex items-center gap-1.5">
      <span aria-hidden>&larr;</span> {children}
    </Link>
  );
}
