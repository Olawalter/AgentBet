"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getMarket, getPosition, getClaimable, getResolution,
  stake, closeMarket, resolveMarket, claimWinnings, claimRefund,
  markUnresolved, cancelMarket,
} from "@/lib/contract";
import type { Market, Position, Claimable, Resolution } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { useTx } from "@/lib/useTx";
import {
  toGen, genToWei, impliedPct, formatEpoch, relativeTo, shortAddress, hostOf,
} from "@/lib/format";
import {
  Panel, Label, Button, StatusPill, PoolBar, Stat, TxStatus, BackLink,
} from "@/components/ui";

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { address, wrongNetwork, connect, switchNetwork } = useWallet();
  const { tx, run, reset } = useTx();

  const [market, setMarket] = useState<Market | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [claim, setClaim] = useState<Claimable | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);

  /** Single source of truth: after any write we re-read, never assume. */
  const refresh = useCallback(async () => {
    try {
      const m = await getMarket(id);
      setMarket(m);
      const [r] = await Promise.all([getResolution(id)]);
      setResolution(r);
      if (address) {
        const [p, c] = await Promise.all([
          getPosition(id, address),
          getClaimable(id, address),
        ]);
        setPosition(p);
        setClaim(c);
      } else {
        setPosition(null);
        setClaim(null);
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loadError) {
    return (
      <div className="mx-auto max-w-[1180px] px-5 py-16">
        <Panel className="p-6 border-no/40">
          <p className="text-[13px] text-no">Could not load market #{id}: {loadError}</p>
          <div className="mt-4"><BackLink href="/markets">All markets</BackLink></div>
        </Panel>
      </div>
    );
  }

  if (!market) {
    return (
      <div className="mx-auto max-w-[1180px] px-5 py-16">
        <p className="text-bone-faint text-[13px]">Reading contract state…</p>
      </div>
    );
  }

  const wei = genToWei(amount);
  const isOpen = market.status === "open";
  const canStake = isOpen && !!address && !wrongNetwork && !!wei && wei > 0n;
  const isCreator = address?.toLowerCase() === market.creator.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const resolutionOpen = nowSec >= Number(market.resolution_start);
  const busy = ["awaiting_wallet", "submitted", "pending"].includes(tx.phase);

  const doStake = async () => {
    if (!address || !wei) return;
    const ok = await run(
      (hooks) => stake(address, id, side, wei, hooks),
      refresh,
    );
    if (ok) { setAmount(""); setConfirming(false); }
  };

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-8">
      <BackLink href="/markets">All markets</BackLink>

      {/* Header */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[720px]">
          <div className="flex items-center gap-3">
            <span className="label">Market #{market.id}</span>
            <StatusPill status={market.status} outcome={market.final_outcome} />
          </div>
          <h1 className="mt-3 text-[26px] sm:text-[32px] font-display font-semibold tracking-tight leading-tight">
            {market.question}
          </h1>
          {market.description && (
            <p className="mt-3 text-[13.5px] leading-relaxed text-bone-dim">{market.description}</p>
          )}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_360px] items-start">
        {/* ── Left column ── */}
        <div className="space-y-6">
          {/* Pools */}
          <Panel className="p-6" tick>
            <div className="flex items-center justify-between">
              <Label>Stake distribution</Label>
              <span className="label">{market.staker_count} staker{market.staker_count === 1 ? "" : "s"}</span>
            </div>
            <div className="mt-4"><PoolBar yes={market.yes_total} no={market.no_total} /></div>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <Stat
                label="YES pool"
                value={`${toGen(market.yes_total)} GEN`}
                sub={`${impliedPct("YES", market.yes_total, market.no_total).toFixed(1)}% of stakes`}
                accent="yes"
              />
              <Stat
                label="NO pool"
                value={`${toGen(market.no_total)} GEN`}
                sub={`${impliedPct("NO", market.yes_total, market.no_total).toFixed(1)}% of stakes`}
                accent="no"
              />
              <Stat
                label="Total escrow"
                value={`${toGen(market.escrow_total)} GEN`}
                sub={`${toGen(market.escrow_remaining)} GEN unsettled`}
                accent="amber"
              />
            </div>
            <p className="mt-4 text-[11px] text-bone-faint leading-relaxed">
              Percentages describe how capital is split across the two sides. They
              are not probabilities the contract endorses, and they are not payouts.
            </p>
          </Panel>

          {/* Resolution terms */}
          <Panel className="p-6">
            <Label>Resolution terms — fixed at creation, no setter exists</Label>
            <dl className="mt-4 space-y-3 text-[13px]">
              <div className="flex flex-wrap gap-x-4">
                <dt className="w-[150px] text-bone-faint shrink-0">Condition</dt>
                <dd className="text-bone flex-1">{market.condition_text}</dd>
              </div>
              <div className="flex flex-wrap gap-x-4">
                <dt className="w-[150px] text-bone-faint shrink-0">Rule</dt>
                <dd className="text-bone flex-1">
                  {market.rule_kind === "SPOT_THRESHOLD"
                    ? `Spot price of ${market.subject} ${market.comparator} $${market.threshold_text}, evaluated at resolution time`
                    : `Semantic judgment on: ${market.subject}`}
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-4">
                <dt className="w-[150px] text-bone-faint shrink-0">Staking closes</dt>
                <dd className="tnum text-bone flex-1">
                  {formatEpoch(market.resolution_start)}{" "}
                  <span className="text-bone-faint">({relativeTo(market.resolution_start)})</span>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-4">
                <dt className="w-[150px] text-bone-faint shrink-0">Recovery opens</dt>
                <dd className="tnum text-bone flex-1">{formatEpoch(market.recovery_deadline)}</dd>
              </div>
              <div className="flex flex-wrap gap-x-4">
                <dt className="w-[150px] text-bone-faint shrink-0">Creator</dt>
                <dd className="tnum text-bone flex-1">{shortAddress(market.creator, 6)}</dd>
              </div>
            </dl>

            <div className="mt-5 rule pt-4">
              <Label>Bound evidence sources</Label>
              <ul className="mt-2 space-y-1.5">
                {market.resolution_sources.map((u) => (
                  <li key={u} className="text-[12px] tnum text-bone-dim flex items-start gap-2">
                    <span className="text-bone-faint">·</span>
                    <span className="break-all">{hostOf(u)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-bone-faint leading-relaxed">
                Independent operators, fixed by the contract. The market creator
                chose a subject, not a URL, and cannot edit what validators read.
              </p>
            </div>
          </Panel>

          {/* Evidence / adjudication */}
          <Panel className="p-6">
            <Label>GenLayer adjudication</Label>
            {!resolution?.exists ? (
              <div className="mt-4">
                <p className="text-[13px] text-bone-dim">
                  {isOpen
                    ? "Not started. Resolution opens once the staking window closes."
                    : "Awaiting resolution. Anyone may trigger it."}
                </p>
                {!isOpen && resolutionOpen && address && !wrongNetwork && (
                  <Button
                    className="mt-4"
                    disabled={busy}
                    onClick={() => void run((h) => resolveMarket(address, id, h), refresh)}
                  >
                    Run resolution
                  </Button>
                )}
              </div>
            ) : (
              <div className="mt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`inline-flex h-7 items-center px-2.5 border text-[11px] font-mono tracking-[0.14em] ${
                      resolution.outcome === "YES" ? "text-yes border-yes/40" :
                      resolution.outcome === "NO" ? "text-no border-no/40" :
                      "text-bone-dim border-bone-faint/50"
                    }`}
                  >
                    {resolution.outcome}
                  </span>
                  <span className="label">
                    {resolution.sufficient ? "evidence sufficient" : "evidence insufficient — refundable"}
                  </span>
                  {resolution.observed_summary && (
                    <span className="tnum text-[13px] text-bone">
                      observed {resolution.observed_summary}
                    </span>
                  )}
                </div>
                {resolution.reason && (
                  <p className="mt-3 text-[13px] leading-relaxed text-bone-dim">{resolution.reason}</p>
                )}

                <div className="mt-5 rule pt-4">
                  <Label>What the validators fetched</Label>
                  <div className="mt-3 space-y-2">
                    {resolution.rows.map((row, i) => (
                      <div key={i} className="border border-ink-line p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="tnum text-[12px] text-bone-dim break-all">{hostOf(row.url)}</span>
                          <span
                            className={`label ${row.readable ? "text-yes" : "text-no"}`}
                          >
                            {row.readable ? "retrieved" : "unreachable"}
                          </span>
                        </div>
                        {row.observed && (
                          <div className="mt-1.5 tnum text-[13px] text-bone">{row.observed}</div>
                        )}
                        {row.digest && (
                          <div className="mt-1.5 label break-all">
                            sha256 {row.digest.slice(0, 32)}…
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[11px] text-bone-faint leading-relaxed">
                    Each digest covers the exact excerpt stored on-chain, so the
                    record can be re-checked independently later.
                  </p>
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* ── Right dock ── */}
        <div className="space-y-6 lg:sticky lg:top-20">
          {/* Your position / settlement */}
          <Panel className="p-6" tick>
            <Label>Your position</Label>

            {!address ? (
              <div className="mt-4">
                <p className="text-[13px] text-bone-dim">Connect a wallet to stake.</p>
                <Button className="mt-4" full onClick={() => void connect()}>Connect wallet</Button>
              </div>
            ) : position?.exists ? (
              <div className="mt-4 space-y-4">
                <div className="flex items-baseline justify-between">
                  <span className={`text-[20px] font-display font-semibold ${position.side === "YES" ? "text-yes" : "text-no"}`}>
                    {position.side}
                  </span>
                  <span className="tnum text-[16px]">{toGen(position.amount ?? "0")} GEN</span>
                </div>

                {claim && (
                  <div className="rule pt-4">
                    {claim.claimable ? (
                      <>
                        <Label>{claim.kind === "refund" ? "Refundable" : "Claimable"}</Label>
                        <div className="tnum text-[22px] text-amber mt-1">
                          {toGen(claim.amount)} GEN
                        </div>
                        <p className="text-[11px] text-bone-faint mt-1">
                          Computed by the contract from its own ledger.
                        </p>
                        {wrongNetwork ? (
                          <Button className="mt-4" full variant="danger" onClick={() => void switchNetwork()}>
                            Switch network to claim
                          </Button>
                        ) : (
                          <Button
                            className="mt-4"
                            full
                            disabled={busy}
                            onClick={() =>
                              void run(
                                (h) => claim.kind === "refund"
                                  ? claimRefund(address, id, h)
                                  : claimWinnings(address, id, h),
                                refresh,
                              )
                            }
                          >
                            {claim.kind === "refund"
                              ? `Claim refund of ${toGen(claim.amount)} GEN`
                              : `Claim ${toGen(claim.amount)} GEN`}
                          </Button>
                        )}
                      </>
                    ) : position.claimed ? (
                      <>
                        <Label>Settled</Label>
                        <div className="tnum text-[18px] text-bone mt-1">
                          {toGen(position.payout ?? "0")} GEN paid
                        </div>
                        <p className="text-[12px] text-bone-faint mt-1.5">
                          This position has been settled and cannot be claimed again.
                        </p>
                      </>
                    ) : (
                      <>
                        <Label>Not claimable</Label>
                        <p className="text-[12.5px] text-bone-dim mt-1.5 leading-relaxed">
                          {claim.reason}
                        </p>
                        {claim.claimable_at && market.status === "finalized" && (
                          <p className="text-[11px] text-bone-faint mt-2">
                            Settlement unlocks {relativeTo(claim.claimable_at)} — the
                            resolution&apos;s appeal window.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-4 text-[13px] text-bone-dim">
                {isOpen ? "No position yet." : "You did not stake in this market."}
              </p>
            )}
          </Panel>

          {/* Stake form */}
          {isOpen && address && (
            <Panel className="p-6">
              <Label>Take a side</Label>
              {position?.exists && (
                <p className="mt-2 text-[11px] text-bone-faint">
                  You hold {position.side}. Adding more increases that position;
                  the contract does not allow staking both sides.
                </p>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2">
                {(["YES", "NO"] as const).map((s) => {
                  const locked = position?.exists && position.side !== s;
                  return (
                    <button
                      key={s}
                      disabled={!!locked}
                      onClick={() => setSide(s)}
                      className={`h-11 border text-[14px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                        side === s
                          ? s === "YES"
                            ? "border-yes text-yes bg-yes/10"
                            : "border-no text-no bg-no/10"
                          : "border-ink-line text-bone-faint hover:text-bone-dim"
                      }`}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>

              <div className="mt-4">
                <Label>Amount (GEN)</Label>
                <input
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setConfirming(false); }}
                  inputMode="decimal"
                  placeholder="0.5"
                  className="mt-1.5 w-full h-11 bg-ink px-3 border border-ink-line tnum text-[15px] text-bone outline-none focus:border-amber"
                />
                {amount && !wei && (
                  <p className="mt-1.5 text-[11px] text-no">Enter a valid amount.</p>
                )}
              </div>

              {confirming ? (
                <div className="mt-4 border border-amber/40 bg-amber/5 p-4">
                  <p className="text-[13px] text-bone leading-relaxed">
                    You&apos;re locking{" "}
                    <span className="tnum text-amber">{amount} GEN</span> behind{" "}
                    <span className={side === "YES" ? "text-yes" : "text-no"}>{side}</span>.
                  </p>
                  <p className="mt-2 text-[12px] text-bone-dim leading-relaxed">
                    Your funds stay in the contract&apos;s escrow until the market is
                    resolved and finalized. If the evidence cannot settle the
                    question, the market becomes refundable and you recover this
                    stake.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Button variant="ghost" onClick={() => setConfirming(false)}>Back</Button>
                    <Button full disabled={busy} onClick={() => void doStake()}>
                      Confirm stake
                    </Button>
                  </div>
                </div>
              ) : wrongNetwork ? (
                <Button className="mt-4" full variant="danger" onClick={() => void switchNetwork()}>
                  Switch network to stake
                </Button>
              ) : (
                <Button
                  className="mt-4"
                  full
                  disabled={!canStake || busy}
                  onClick={() => setConfirming(true)}
                >
                  Stake {side}
                </Button>
              )}
            </Panel>
          )}

          {/* Lifecycle actions — permissionless, shown only when actually valid */}
          {address && !wrongNetwork && (
            <Panel className="p-6">
              <Label>Market actions</Label>
              <p className="mt-2 text-[11px] text-bone-faint leading-relaxed">
                These are permissionless: anyone may move a market forward.
              </p>
              <div className="mt-4 space-y-2">
                {isOpen && resolutionOpen && (
                  <Button full variant="ghost" disabled={busy}
                    onClick={() => void run((h) => closeMarket(address, id, h), refresh)}>
                    Close staking
                  </Button>
                )}
                {(market.status === "closed") && (
                  <Button full variant="ghost" disabled={busy}
                    onClick={() => void run((h) => resolveMarket(address, id, h), refresh)}>
                    Run resolution
                  </Button>
                )}
                {["open", "closed"].includes(market.status) &&
                  nowSec > Number(market.recovery_deadline) && (
                    <Button full variant="ghost" disabled={busy}
                      onClick={() => void run((h) => markUnresolved(address, id, h), refresh)}>
                      Open refunds (recovery)
                    </Button>
                  )}
                {isCreator && isOpen && market.escrow_total === "0" && (
                  <Button full variant="danger" disabled={busy}
                    onClick={() => void run((h) => cancelMarket(address, id, h), refresh)}>
                    Cancel market
                  </Button>
                )}
                {!isOpen && market.status !== "closed" &&
                  !(["open", "closed"].includes(market.status)) && (
                    <p className="text-[12px] text-bone-faint">
                      No actions available in this state.
                    </p>
                  )}
              </div>
            </Panel>
          )}

          <TxStatus tx={tx} onDismiss={reset} />

          <div className="text-[11px] text-bone-faint leading-relaxed">
            Every figure on this page is read from the contract.{" "}
            <Link href="/positions" className="link-amber">Your positions</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
