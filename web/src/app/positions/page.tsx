"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getUserMarkets, getMarket, getPosition, getClaimable } from "@/lib/contract";
import type { Market, Position, Claimable } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { toGen } from "@/lib/format";
import { Panel, Label, Button, StatusPill, Empty } from "@/components/ui";

interface Row {
  market: Market;
  position: Position;
  claim: Claimable;
}

export default function PositionsPage() {
  const { address, connect } = useWallet();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) {
      setRows(null);
      return;
    }
    try {
      const ids = await getUserMarkets(address);
      const unique = Array.from(new Set(ids));
      const out = await Promise.all(
        unique.map(async (id) => {
          const [market, position, claim] = await Promise.all([
            getMarket(id),
            getPosition(id, address),
            getClaimable(id, address),
          ]);
          return { market, position, claim };
        }),
      );
      setRows(out.reverse());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalStaked = (rows ?? []).reduce(
    (acc, r) => acc + BigInt(r.position.amount ?? "0"),
    0n,
  );
  const totalClaimable = (rows ?? []).reduce(
    (acc, r) => acc + (r.claim.claimable ? BigInt(r.claim.amount) : 0n),
    0n,
  );

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-10">
      <Label>Portfolio</Label>
      <h1 className="mt-2 text-[30px] font-display font-semibold tracking-tight">
        Your positions
      </h1>

      {!address ? (
        <div className="mt-8">
          <Empty
            title="Connect a wallet to see your positions."
            hint="Positions are read from the contract by address — nothing is stored in this browser."
            cta={<Button onClick={() => void connect()}>Connect wallet</Button>}
          />
        </div>
      ) : error ? (
        <Panel className="mt-8 p-5 border-no/40">
          <p className="text-[13px] text-no">Could not read positions: {error}</p>
        </Panel>
      ) : rows === null ? (
        <p className="mt-8 text-[13px] text-bone-faint">Reading contract state…</p>
      ) : rows.length === 0 ? (
        <div className="mt-8">
          <Empty
            title="No positions yet."
            hint="Stake on a market and it will appear here."
            cta={<Link href="/markets"><Button>Browse markets</Button></Link>}
          />
        </div>
      ) : (
        <>
          <div className="mt-6 grid sm:grid-cols-3 gap-px bg-ink-line border border-ink-line">
            <div className="bg-ink-raised p-5">
              <Label>Positions</Label>
              <div className="tnum text-[20px] mt-1">{rows.length}</div>
            </div>
            <div className="bg-ink-raised p-5">
              <Label>Total staked</Label>
              <div className="tnum text-[20px] mt-1">{toGen(totalStaked)} GEN</div>
            </div>
            <div className="bg-ink-raised p-5">
              <Label>Claimable now</Label>
              <div className={`tnum text-[20px] mt-1 ${totalClaimable > 0n ? "text-amber" : ""}`}>
                {toGen(totalClaimable)} GEN
              </div>
            </div>
          </div>

          <div className="mt-6 border border-ink-line">
            {rows.map(({ market, position, claim }) => (
              <Link
                key={market.id}
                href={`/markets/${market.id}`}
                className="flex flex-wrap items-center gap-4 px-4 py-4 border-b border-ink-line last:border-b-0 hover:bg-ink-raised transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] text-bone leading-snug">{market.question}</p>
                  <div className="mt-1.5 flex items-center gap-3">
                    <span className="label">#{market.id}</span>
                    <StatusPill status={market.status} outcome={market.final_outcome} />
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-[13px] font-medium ${position.side === "YES" ? "text-yes" : "text-no"}`}>
                    {position.side}
                  </div>
                  <div className="tnum text-[13px] text-bone-dim">
                    {toGen(position.amount ?? "0")} GEN
                  </div>
                </div>
                <div className="w-[150px] text-right">
                  {claim.claimable ? (
                    <>
                      <div className="label text-amber">
                        {claim.kind === "refund" ? "refundable" : "claimable"}
                      </div>
                      <div className="tnum text-[14px] text-amber">{toGen(claim.amount)} GEN</div>
                    </>
                  ) : position.claimed ? (
                    <>
                      <div className="label">settled</div>
                      <div className="tnum text-[13px] text-bone-dim">
                        {toGen(position.payout ?? "0")} GEN
                      </div>
                    </>
                  ) : (
                    <div className="text-[11.5px] text-bone-faint leading-snug">{claim.reason}</div>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {address && (
            <p className="mt-4 text-[11px] text-bone-faint">
              Reputation for this wallet:{" "}
              <Link href={`/agents/${address}`} className="link-amber">view agent profile</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
