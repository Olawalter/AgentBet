"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listMarkets } from "@/lib/contract";
import type { MarketSummary, MarketStatus } from "@/lib/types";
import { toGen, impliedPct, relativeTo } from "@/lib/format";
import { StatusPill, PoolBar, Label, Panel, Empty, Button } from "@/components/ui";

type Filter = "all" | "open" | "resolved";

export default function MarketsPage() {
  const [items, setItems] = useState<MarketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let alive = true;
    listMarkets(0, 50)
      .then((p) => alive && setItems(p.items))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  const visible = (items ?? []).filter((m) => {
    if (filter === "open") return m.status === "open";
    if (filter === "resolved")
      return ["finalized", "settled", "refundable"].includes(m.status as MarketStatus);
    return true;
  });

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Label>Markets</Label>
          <h1 className="mt-2 text-[30px] font-display font-semibold tracking-tight">
            Open questions, real escrow
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {(["all", "open", "resolved"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`h-8 px-3 text-[12px] border capitalize ${
                filter === f
                  ? "border-amber text-amber"
                  : "border-ink-line text-bone-faint hover:text-bone-dim"
              }`}
            >
              {f}
            </button>
          ))}
          <Link
            href="/markets/new"
            className="h-8 px-3 inline-flex items-center text-[12px] bg-amber text-ink hover:bg-amber-soft"
          >
            Create
          </Link>
        </div>
      </div>

      <div className="mt-8">
        {error && (
          <Panel className="p-5 border-no/40">
            <p className="text-[13px] text-no">Could not read markets: {error}</p>
          </Panel>
        )}

        {!error && items === null && (
          <Panel className="p-10 text-center">
            <p className="text-bone-faint text-[13px]">Reading contract state…</p>
          </Panel>
        )}

        {!error && items !== null && visible.length === 0 && (
          <Empty
            title="No markets here yet."
            hint="Create the first one — it will be a real market on StudioNet."
            cta={
              <Link href="/markets/new">
                <Button>Create a market</Button>
              </Link>
            }
          />
        )}

        {visible.length > 0 && (
          <div className="border border-ink-line">
            {/* header row */}
            <div className="hidden md:grid grid-cols-[80px_1fr_150px_130px_120px] gap-4 px-4 py-2.5 border-b border-ink-line bg-ink-raised">
              {["ID", "Question", "Pool split", "Escrow", "Status"].map((h) => (
                <div key={h} className="label">{h}</div>
              ))}
            </div>
            {visible.map((m) => (
              <Link
                key={m.id}
                href={`/markets/${m.id}`}
                className="grid md:grid-cols-[80px_1fr_150px_130px_120px] gap-4 px-4 py-4 border-b border-ink-line last:border-b-0 hover:bg-ink-raised transition-colors"
              >
                <div className="tnum text-[13px] text-bone-faint">#{m.id}</div>
                <div className="min-w-0">
                  <p className="text-[13.5px] text-bone leading-snug">{m.question}</p>
                  <p className="mt-1 label">
                    {m.subject} · {m.rule_kind === "SPOT_THRESHOLD" ? "price rule" : "event rule"}
                    {m.status === "open" && ` · closes ${relativeTo(m.resolution_start)}`}
                  </p>
                </div>
                <div>
                  <PoolBar yes={m.yes_total} no={m.no_total} />
                  <div className="mt-1.5 flex justify-between text-[11px] tnum">
                    <span className="text-yes">{impliedPct("YES", m.yes_total, m.no_total).toFixed(0)}%</span>
                    <span className="text-no">{impliedPct("NO", m.yes_total, m.no_total).toFixed(0)}%</span>
                  </div>
                </div>
                <div className="tnum text-[13px]">
                  {toGen(m.escrow_total)} <span className="text-bone-faint text-[11px]">GEN</span>
                  <div className="label mt-0.5">{m.staker_count} staker{m.staker_count === 1 ? "" : "s"}</div>
                </div>
                <div><StatusPill status={m.status} outcome={m.final_outcome} /></div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
