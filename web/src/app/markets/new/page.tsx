"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createMarket, getConfig, listMarkets } from "@/lib/contract";
import type { Config } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { useTx } from "@/lib/useTx";
import { Panel, Label, Button, TxStatus, BackLink } from "@/components/ui";

const HOURS = [
  { label: "1 hour", value: 3600 },
  { label: "6 hours", value: 21600 },
  { label: "24 hours", value: 86400 },
  { label: "7 days", value: 604800 },
];

export default function NewMarketPage() {
  const router = useRouter();
  const { address, wrongNetwork, connect, switchNetwork } = useWallet();
  const { tx, run, reset } = useTx();

  const [cfg, setCfg] = useState<Config | null>(null);
  const [rule, setRule] = useState<"SPOT_THRESHOLD" | "EVENT_CLAIM">("SPOT_THRESHOLD");
  const [subject, setSubject] = useState("BTC/USD");
  const [comparator, setComparator] = useState(">=");
  const [threshold, setThreshold] = useState("70000");
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [claimSubject, setClaimSubject] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [openFor, setOpenFor] = useState(3600);
  const [windowFor, setWindowFor] = useState(86400);

  useEffect(() => {
    getConfig().then(setCfg).catch(() => setCfg(null));
  }, []);

  const thresholdCents = Math.round(Number(threshold || "0") * 100);
  const sources = sourceText.split("\n").map((s) => s.trim()).filter(Boolean);
  const busy = ["awaiting_wallet", "submitted", "pending"].includes(tx.phase);

  const autoQuestion =
    rule === "SPOT_THRESHOLD"
      ? `Will ${subject} be at or ${comparator === ">=" ? "above" : "below"} $${Number(threshold || 0).toLocaleString()} at resolution?`
      : "";

  const effectiveQuestion = question.trim() || autoQuestion;
  const conditionText =
    rule === "SPOT_THRESHOLD"
      ? `${subject} ${comparator} ${thresholdCents / 100} at the observation instant (the moment staking closes), from the contract's independent historical feeds`
      : `Independent cited sources establish that: ${claimSubject.trim()}`;

  const valid =
    !!address && !wrongNetwork && effectiveQuestion.length > 0 &&
    (rule === "SPOT_THRESHOLD"
      ? thresholdCents > 0
      : claimSubject.trim().length > 0 && sources.length > 0);

  const submit = async () => {
    if (!address || !valid) return;
    const start = Math.floor(Date.now() / 1000) + openFor;
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
            conditionText,
            resolutionStart: start,
            resolutionDeadline: start + windowFor,
            claimSources: rule === "EVENT_CLAIM" ? sources : [],
          },
          hooks,
        ),
      async () => {
        const page = await listMarkets(0, 50);
        const latest = page.items[page.items.length - 1];
        if (latest) router.push(`/markets/${latest.id}`);
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
                The contract reads its own independent feeds, requires at least
                two to corroborate within {((cfg?.price_tolerance_bps ?? 100) / 100).toFixed(0)}%,
                and compares the median to your threshold. This is a
                spot-at-resolution rule: it answers whether the price is above
                the threshold when the market resolves, not whether it ever
                touched it earlier.
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
                {HOURS.map((h) => (
                  <button
                    key={h.value}
                    onClick={() => setOpenFor(h.value)}
                    className={`h-9 text-[11.5px] border ${
                      openFor === h.value ? "border-amber text-amber" : "border-ink-line text-bone-faint hover:text-bone-dim"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="label mb-1.5">Resolution window</div>
              <div className="grid grid-cols-4 gap-1.5">
                {HOURS.map((h) => (
                  <button
                    key={h.value}
                    onClick={() => setWindowFor(h.value)}
                    className={`h-9 text-[11.5px] border ${
                      windowFor === h.value ? "border-amber text-amber" : "border-ink-line text-bone-faint hover:text-bone-dim"
                    }`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="mt-3 text-[11.5px] text-bone-faint leading-relaxed">
            If the market still has not resolved{" "}
            {Math.round((cfg?.recovery_grace ?? 259200) / 86400)} days after the
            resolution deadline, any participant can permanently open refunds.
            Funds cannot strand.
          </p>
        </Panel>

        {/* Summary + submit */}
        <Panel className="p-6" tick>
          <Label>The contract will record</Label>
          <p className="mt-3 text-[14px] text-bone leading-snug">{effectiveQuestion || "—"}</p>
          <p className="mt-2 text-[12.5px] text-bone-dim leading-relaxed">{conditionText}</p>

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
