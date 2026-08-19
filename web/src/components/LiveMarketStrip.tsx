"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listMarkets } from "@/lib/contract";
import type { MarketSummary } from "@/lib/types";
import { toGen, impliedPct } from "@/lib/format";
import { StatusPill, PoolBar, Label } from "./ui";

/**
 * Live markets read straight from the contract. If the contract has no markets,
 * this renders nothing — the landing page never invents a demo market, because
 * a fake market on a page about trustless settlement would be self-defeating.
 */
export function LiveMarketStrip() {
  const [items, setItems] = useState<MarketSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    listMarkets(0, 3)
      .then((p) => alive && setItems(p.items))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <section className="border-b border-ink-line bg-ink-raised">
      <div className="mx-auto max-w-[1180px] px-5 py-8">
        <div className="flex items-baseline justify-between">
          <Label>Live on StudioNet</Label>
          <Link href="/markets" className="link-amber text-[12px]">
            All markets
          </Link>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {items.map((m) => (
            <Link
              key={m.id}
              href={`/markets/${m.id}`}
              className="panel p-4 hover:border-bone-faint transition-colors block"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="label">#{m.id} · {m.subject}</span>
                <StatusPill status={m.status} outcome={m.final_outcome} />
              </div>
              <p className="mt-3 text-[13.5px] leading-snug text-bone line-clamp-2">
                {m.question}
              </p>
              <div className="mt-4">
                <PoolBar yes={m.yes_total} no={m.no_total} />
                <div className="mt-2 flex justify-between text-[11px] tnum">
                  <span className="text-yes">
                    YES {impliedPct("YES", m.yes_total, m.no_total).toFixed(0)}%
                  </span>
                  <span className="text-bone-faint">{toGen(m.escrow_total)} GEN</span>
                  <span className="text-no">
                    NO {impliedPct("NO", m.yes_total, m.no_total).toFixed(0)}%
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
