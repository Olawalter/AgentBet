"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listMarkets } from "@/lib/contract";
import type { MarketSummary } from "@/lib/types";
import { toGen, impliedPct } from "@/lib/format";
import { StatusPill, PoolBar } from "./ui";

/**
 * The hero's right half: live contract state, not decoration.
 *
 * If the contract has no markets this renders an honest empty board rather than
 * inventing one — a fabricated market on a page arguing for trustless
 * settlement would undercut the entire claim.
 */
export function LiveBoard() {
  const [items, setItems] = useState<MarketSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    listMarkets(0, 20)
      .then((p) => alive && setItems(p.items))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const escrow = (items ?? []).reduce((a, m) => a + BigInt(m.escrow_total), 0n);
  const settled = (items ?? []).filter((m) =>
    ["finalized", "settled"].includes(m.status),
  ).length;
  const recent = (items ?? []).slice(-2).reverse();

  return (
    <div className="panel panel-tick">
      <div className="flex items-center justify-between px-4 h-10 border-b border-ink-line">
        <span className="label flex items-center gap-2">
          <span className="h-1.5 w-1.5 bg-amber pulse-dot" />
          Live on StudioNet
        </span>
        <Link href="/markets" className="link-amber text-[11px]">
          All markets
        </Link>
      </div>

      {/* Totals, straight from the contract */}
      <div className="grid grid-cols-3 divide-x divide-ink-line border-b border-ink-line">
        {[
          ["Markets", items ? String(items.length) : "—"],
          ["In escrow", items ? `${toGen(escrow)}` : "—"],
          ["Settled", items ? String(settled) : "—"],
        ].map(([l, v]) => (
          <div key={l} className="px-4 py-3">
            <div className="label">{l}</div>
            <div className="tnum text-[19px] mt-1 text-bone">{v}</div>
          </div>
        ))}
      </div>

      <div className="divide-y divide-ink-line">
        {failed && (
          <p className="px-4 py-6 text-[12.5px] text-bone-dim">
            Could not reach the contract from this browser.
          </p>
        )}
        {!failed && items === null && (
          <p className="px-4 py-6 text-[12.5px] text-bone-faint">
            Reading contract state…
          </p>
        )}
        {!failed && items !== null && recent.length === 0 && (
          <p className="px-4 py-6 text-[12.5px] text-bone-dim">
            No markets yet.{" "}
            <Link href="/markets/new" className="link-amber">
              Create the first one
            </Link>
            .
          </p>
        )}
        {recent.map((m) => (
          <Link
            key={m.id}
            href={`/markets/${m.id}`}
            className="block px-4 py-3.5 hover:bg-ink-panel transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="label">
                #{m.id} · {m.subject}
              </span>
              <StatusPill status={m.status} outcome={m.final_outcome} />
            </div>
            <p className="mt-2 text-[13px] leading-snug text-bone line-clamp-2">
              {m.question}
            </p>
            <div className="mt-2.5">
              <PoolBar yes={m.yes_total} no={m.no_total} />
              <div className="mt-1.5 flex justify-between text-[11px] tnum">
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
  );
}
