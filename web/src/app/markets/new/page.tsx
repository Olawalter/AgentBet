"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createMarket, getConfig, listMarkets } from "@/lib/contract";
import type { Config } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { useTx } from "@/lib/useTx";
import { useNow } from "@/lib/useNow";
import {
  MAX_PRICE_RESOLUTION_WINDOW_SECONDS,
  RESOLUTION_WINDOW_OPTIONS,
  STAKING_OPEN_OPTIONS,
  describeDuration,
  validateMarketTiming,
} from "@/lib/rules";
import { formatEpoch } from "@/lib/format";
import { Panel, Label, Button, TxStatus, BackLink } from "@/components/ui";

/** Mirrors the contract's MIN_MARKET_WINDOW until get_config has loaded; the
 * contract's own value replaces it as soon as the read returns. */
const FALLBACK_MIN_MARKET_WINDOW = 120;

export default function NewMarketPage() {
  const router = useRouter();
  const { address, wrongNetwork, connect, switchNetwork } = useWallet();
  const { tx, run, reset, fail } = useTx();
  const nowSec = useNow(15_000);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [rule, setRule] = useState<"SPOT_THRESHOLD" | "EVENT_CLAIM">("SPOT_THRESHOLD");
  const [subject, setSubject] = useState("BTC/USD");
  const [comparator, setComparator] = useState(">=");
  const [threshold, setThreshold] = useState("70000");
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [claimSubject, setClaimSubject] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [openFor, setOpenFor] = useState(STAKING_OPEN_OPTIONS[0].seconds);
  const [windowFor, setWindowFor] = useState(RESOLUTION_WINDOW_OPTIONS[3].seconds);

  useEffect(() => {
    getConfig().then(setCfg).catch(() => setCfg(null));
  }, []);

  const thresholdCents = Math.round(Number(threshold || "0") * 100);
  const sources = sourceText.split("\n").map((s) => s.trim()).filter(Boolean);
  const busy = ["awaiting_wallet", "submitted", "pending"].includes(tx.phase);
  const minMarketWindow = cfg?.min_market_window ?? FALLBACK_MIN_MARKET_WINDOW;

  // The same rule the contract applies, evaluated continuously so the page can
  // explain a problem before the wallet is ever opened. Re-run at submit time
  // with a fresh clock — see submit().
  const timing = validateMarketTiming({
    nowSec, openFor, windowFor, ruleKind: rule, minMarketWindow,
  });

  const autoQuestion =
    rule === "SPOT_THRESHOLD"
      ? `Will ${subject} be at or ${comparator === ">=" ? "above" : "below"} $${Number(threshold || 0).toLocaleString()} at the observation instant (when staking closes)?`
      : "";

  const effectiveQuestion = question.trim() || autoQuestion;

  // Settlement is anchored to the predetermined observation instant. The
  // condition the contract records names that instant explicitly so nobody
  // reading it later can mistake "when resolved" for the datum.
  // The epoch is included verbatim because this string is immutable on-chain and
  // a reader must be able to check it against resolution_start exactly — a
  // minute-rounded timestamp could sit up to 59s away from the real datum.
  const conditionFor = (start: number) =>
    rule === "SPOT_THRESHOLD"
      ? `${subject} ${comparator} ${thresholdCents / 100} observed at the predetermined instant ` +
        `${start} (resolution_start, ${formatEpoch(start)}), median of the contract's ` +
        `independent historical feeds`
      : `Independent cited sources establish that: ${claimSubject.trim()}`;

  const valid =
    !!address && !wrongNetwork && effectiveQuestion.length > 0 && timing.ok &&
    (rule === "SPOT_THRESHOLD"
      ? thresholdCents > 0
      : claimSubject.trim().length > 0 && sources.length > 0);

  const submit = async () => {
    if (!address || !valid) return;
    // Final validation immediately before submission, against a fresh clock:
    // the displayed check may be up to 15s old. The contract re-checks every
    // bound with its own consensus clock when the transaction arrives.
    const fresh = validateMarketTiming({
      nowSec: Math.floor(Date.now() / 1000), openFor, windowFor,
      ruleKind: rule, minMarketWindow,
    });
    if (!fresh.ok) {
      fail(new Error(fresh.errors.join(" ")));
      return;
    }
    const start = fresh.resolutionStart;
    const ok = await run(
      (hooks) =>
        createMarket(
          address,
          {
            question: effectiveQuestion,
            description,
            ruleKind: rule,
            subject: rule === "SPOT_THRESHOLD" ? subject : claimSubject.trim(),
            comparator: rule === "SPOT_THRESHOLD" ? comparator : "",
            thresholdCents: rule === "SPOT_THRESHOLD" ? thresholdCents : 0,
            conditionText: conditionFor(start),
            resolutionStart: start,
            resolutionDeadline: fresh.resolutionDeadline,
            claimSources: rule === "EVENT_CLAIM" ? sources : [],
          },
          hooks,
        ),
      {
        after: async () => {
          const page = await listMarkets(0, 50);
          const latest = page.items[page.items.length - 1];
          if (latest) router.push(`/markets/${latest.id}`);
        },
      },
    );
    if (!ok) return;
  };

  return (
    <div className="mx-auto max-w-[820px] px-5 py-8">
      <BackLink href="/markets">All markets</BackLink>
      <h1 className="mt-4 text-[30px] font-display font-semibold tracking-tight">
        Create a market
      </h1>
      <p className="mt-2 text-[13.5px] text-bone-dim leading-relaxed">
        Everything you set here is fixed at creation. There is no setter for the
        outcome, the threshold, the sources or the deadlines — once someone
        stakes, you cannot change or cancel the market.
      </p>

      <div className="mt-8 space-y-6">
        {/* Rule kind */}
        <Panel className="p-6">
          <Label>Resolution rule</Label>
          <div className="mt-3 grid sm:grid-cols-2 gap-2">
            {([
              ["SPOT_THRESHOLD", "Price threshold", "Settled by contract arithmetic over independent exchange feeds."],
              ["EVENT_CLAIM", "Event claim", "Settled by validator judgment over cited independent publishers."],
            ] as const).map(([v, t, d]) => (
              <button
                key={v}
                onClick={() => setRule(v)}
                className={`text-left p-4 border transition-colors ${
                  rule === v ? "border-amber bg-amber/5" : "border-ink-line hover:border-bone-faint"
                }`}
              >
                <div className={`text-[14px] font-medium ${rule === v ? "text-amber" : "text-bone"}`}>{t}</div>
                <div className="mt-1 text-[12px] text-bone-faint leading-relaxed">{d}</div>
              </button>
            ))}
          </div>
        </Panel>

        {/* Rule detail */}
        <Panel className="p-6">
          {rule === "SPOT_THRESHOLD" ? (
            <>
              <Label>Subject and threshold</Label>
              <div className="mt-3 grid sm:grid-cols-3 gap-3">
                <div>
                  <div className="label mb-1.5">Subject</div>
                  <select
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="w-full h-11 bg-ink px-3 border border-ink-line text-[14px] text-bone outline-none focus:border-amber"
                  >
                    {(cfg?.price_subjects ?? ["BTC/USD"]).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="label mb-1.5">Comparator</div>
                  <select
                    value={comparator}
                    onChange={(e) => setComparator(e.target.value)}
                    className="w-full h-11 bg-ink px-3 border border-ink-line text-[14px] text-bone outline-none focus:border-amber"
                  >
                    <option value=">=">at or above</option>
                    <option value="<=">at or below</option>
                  </select>
                </div>
                <div>
                  <div className="label mb-1.5">Threshold (USD)</div>
                  <input
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    inputMode="decimal"
                    className="w-full h-11 bg-ink px-3 border border-ink-line tnum text-[14px] text-bone outline-none focus:border-amber"
                  />
                </div>
              </div>
              <p className="mt-3 text-[11.5px] text-bone-faint leading-relaxed">
                The settlement price is observed at the <span className="text-bone-dim">predetermined
                observation instant</span> — the moment staking closes — not at whatever
                moment someone later runs the resolution. Validators fetch that instant&apos;s
                candle from the contract&apos;s independent feeds, require at least two to
                corroborate within {((cfg?.price_tolerance_bps ?? 100) / 100).toFixed(0)}%, and
                contract arithmetic compares the median to your threshold. It answers
                whether the price was above the threshold at that instant, not whether it
                ever touched it earlier.
              </p>
            </>
          ) : (
            <>
              <Label>Claim and cited sources</Label>
              <div className="mt-3">
                <div className="label mb-1.5">What must be established</div>
                <input
                  value={claimSubject}
                  onChange={(e) => setClaimSubject(e.target.value)}
                  placeholder="e.g. The named mission completed its launch before 1 September 2026"
                  className="w-full h-11 bg-ink px-3 border border-ink-line text-[14px] text-bone outline-none focus:border-amber"
                />
              </div>
              <div className="mt-3">
                <div className="label mb-1.5">Source URLs — one per line</div>
                <textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  rows={3}
                  placeholder="https://www.reuters.com/..."
                  className="w-full bg-ink p-3 border border-ink-line text-[13px] tnum text-bone outline-none focus:border-amber"
                />
                <p className="mt-2 text-[11.5px] text-bone-faint leading-relaxed">
                  Only these independent publishers are accepted:{" "}
                  <span className="tnum">{(cfg?.claim_source_domains ?? []).join(", ")}</span>.
                  A page you host yourself is rejected on-chain — evidence you
                  control is advocacy, not proof.
                </p>
              </div>
            </>
          )}
        </Panel>

        {/* Question */}
        <Panel className="p-6">
          <Label>Question shown to traders</Label>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={autoQuestion || "Will …?"}
            className="mt-3 w-full h-11 bg-ink px-3 border border-ink-line text-[14px] text-bone outline-none focus:border-amber"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Context for traders (optional)"
            className="mt-3 w-full bg-ink p-3 border border-ink-line text-[13px] text-bone outline-none focus:border-amber"
          />
        </Panel>

        {/* Windows */}
        <Panel className="p-6">
          <Label>Timing</Label>
          <div className="mt-3 grid sm:grid-cols-2 gap-4">
            <div>
              <div className="label mb-1.5">Staking stays open for</div>
              <div className="grid grid-cols-4 gap-1.5">
                {STAKING_OPEN_OPTIONS.map((h) => (
                  <button
                    key={h.seconds}
                    onClick={() => setOpenFor(h.seconds)}
                    className={`h-9 text-[11.5px] border ${
                      openFor === h.seconds ? "border-amber text-amber" : "border-ink-line text-bone-faint hover:text-bone-dim"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-bone-faint leading-relaxed">
                Staking closes at the <span className="text-bone-dim">observation instant</span>
                {rule === "SPOT_THRESHOLD" && " — the moment the settlement price is taken"}:{" "}
                <span className="tnum text-bone-dim">{formatEpoch(nowSec + openFor)}</span>
              </p>
            </div>
            <div>
              <div className="label mb-1.5">Resolution window after the instant</div>
              <div className="grid grid-cols-4 gap-1.5">
                {RESOLUTION_WINDOW_OPTIONS.map((h) => (
                  <button
                    key={h.seconds}
                    onClick={() => setWindowFor(h.seconds)}
                    className={`h-9 text-[11.5px] border ${
                      windowFor === h.seconds ? "border-amber text-amber" : "border-ink-line text-bone-faint hover:text-bone-dim"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-bone-faint leading-relaxed">
                Resolution may run until{" "}
                <span className="tnum text-bone-dim">{formatEpoch(nowSec + openFor + windowFor)}</span>.
{" "}Maximum resolution window for a price market:{" "}
                <span className="text-bone-dim">
                  {describeDuration(MAX_PRICE_RESOLUTION_WINDOW_SECONDS)} after the instant (contract limit)
                </span>
                . The price itself is read only at the instant, however long this window is.
                After the deadline the market can only be recovered for refunds.
              </p>
            </div>
          </div>

          {!timing.ok && (
            <div className="mt-4 border border-no/40 bg-no/5 p-3">
              <p className="label text-no">Timing the contract would reject</p>
              <ul className="mt-1.5 space-y-1">
                {timing.errors.map((e) => (
                  <li key={e} className="text-[12px] text-bone-dim">{e}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-3 text-[11.5px] text-bone-faint leading-relaxed">
            If the market still has not resolved{" "}
            {describeDuration(cfg?.recovery_grace ?? 259200)} after the
            resolution deadline, any participant can permanently open refunds.
            Funds cannot strand.
          </p>
        </Panel>

        {/* Summary + submit */}
        <Panel className="p-6" tick>
          <Label>The contract will record</Label>
          <p className="mt-3 text-[14px] text-bone leading-snug">{effectiveQuestion || "—"}</p>
          <p className="mt-2 text-[12.5px] text-bone-dim leading-relaxed">
            {conditionFor(nowSec + openFor)}
          </p>
          {rule === "SPOT_THRESHOLD" && (
            <p className="mt-2 text-[11px] text-bone-faint leading-relaxed">
The instant is fixed when you press Create and is then immutable; the
              preview above tracks the current clock until then.
            </p>
          )}

          {!address ? (
            <Button className="mt-5" full onClick={() => void connect()}>Connect wallet</Button>
          ) : wrongNetwork ? (
            <Button className="mt-5" full variant="danger" onClick={() => void switchNetwork()}>
              Switch network to create
            </Button>
          ) : (
            <Button className="mt-5" full disabled={!valid || busy} onClick={() => void submit()}>
              Create market on StudioNet
            </Button>
          )}
          <TxStatus tx={tx} onDismiss={reset} />
        </Panel>
      </div>
    </div>
  );
}
