"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getAgent } from "@/lib/contract";
import type { AgentStats } from "@/lib/types";
import { toGen, shortAddress } from "@/lib/format";
import { explorerAddress } from "@/lib/network";
import { Panel, Label, BackLink } from "@/components/ui";

export default function AgentPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAgent(address).then(setStats).catch((e) => setError((e as Error).message));
  }, [address]);

  const decided = stats ? stats.correct + stats.incorrect : 0;

  return (
    <div className="mx-auto max-w-[820px] px-5 py-10">
      <BackLink href="/positions">Your positions</BackLink>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label>Agent</Label>
          <h1 className="mt-2 text-[26px] font-display font-semibold tracking-tight tnum">
            {shortAddress(address, 8)}
          </h1>
        </div>
        <a
          className="link-amber text-[12px] tnum"
          href={explorerAddress(address)}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on explorer
        </a>
      </div>

      {error ? (
        <Panel className="mt-8 p-5 border-no/40">
          <p className="text-[13px] text-no">Could not read reputation: {error}</p>
        </Panel>
      ) : !stats ? (
        <p className="mt-8 text-[13px] text-bone-faint">Reading contract state…</p>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-px bg-ink-line border border-ink-line">
            {[
              ["Markets", stats.markets.toString()],
              ["Correct", stats.correct.toString()],
              ["Incorrect", stats.incorrect.toString()],
              ["Accuracy", decided ? `${(stats.accuracy_bps / 100).toFixed(1)}%` : "—"],
            ].map(([l, v]) => (
              <div key={l} className="bg-ink-raised p-5">
                <Label>{l}</Label>
                <div className="tnum text-[22px] mt-1">{v}</div>
              </div>
            ))}
          </div>

          <div className="mt-px grid sm:grid-cols-2 gap-px bg-ink-line border border-ink-line border-t-0">
            <div className="bg-ink-raised p-5">
              <Label>Capital committed</Label>
              <div className="tnum text-[22px] mt-1">{toGen(stats.staked_wei)} GEN</div>
            </div>
            <div className="bg-ink-raised p-5">
              <Label>Capital won</Label>
              <div className="tnum text-[22px] mt-1 text-amber">{toGen(stats.won_wei)} GEN</div>
            </div>
          </div>

          <Panel className="mt-6 p-5">
            <p className="text-[12px] text-bone-faint leading-relaxed">
              Every figure here is derived from contract state: markets and
              capital are counted when a stake is accepted, a loss is booked when
              a market finalizes against the position, and a win is booked when
              the contract pays the claim. This interface cannot add to it.
              {decided === 0 && " No market this wallet staked in has finalized yet."}
            </p>
          </Panel>

          <p className="mt-6 text-[12px] text-bone-faint">
            <Link href="/markets" className="link-amber">Browse markets</Link>
          </p>
        </>
      )}
    </div>
  );
}
