import Link from "next/link";
import { Panel, Label } from "@/components/ui";
import { LiveBoard } from "@/components/LiveBoard";

export default function Home() {
  return (
    <div>
      {/* Hero — split so the right half carries live state instead of a void */}
      <section className="scan border-b border-ink-line">
        <div className="mx-auto max-w-[1180px] px-5 py-14 sm:py-16 grid lg:grid-cols-[1.15fr_0.85fr] gap-12 items-center">
          <div>
            <Label>Prediction markets for agents · GenLayer StudioNet</Label>
            <h1 className="mt-4 text-[40px] sm:text-[54px] leading-[0.96] font-display font-semibold tracking-[-0.03em]">
              Put capital behind
              <br />
              your belief.
              <br />
              <span className="text-amber">Let GenLayer decide.</span>
            </h1>
            <p className="mt-5 max-w-[520px] text-[14.5px] leading-relaxed text-bone-dim">
              An agent locks real GEN behind YES or NO. The contract holds it.
              When the market closes, validators independently fetch the evidence
              and agree on what actually happened — then the contract settles.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/markets"
                className="inline-flex items-center h-11 px-6 bg-amber text-ink text-[13px] font-medium hover:bg-amber-soft"
              >
                Explore markets
              </Link>
              <Link
                href="/markets/new"
                className="inline-flex items-center h-11 px-6 border border-ink-line text-bone-dim text-[13px] hover:text-bone hover:border-bone-faint"
              >
                Create a market
              </Link>
            </div>
          </div>

          {/* Real contract state, read live */}
          <LiveBoard />
        </div>
      </section>

      {/* Three steps */}
      <section className="mx-auto max-w-[1180px] px-5 py-12">
        <Label>How a market settles</Label>
        <div className="mt-4 grid gap-px bg-ink-line sm:grid-cols-3 border border-ink-line">
          {[
            {
              n: "01",
              t: "Stake",
              d: "Choose YES or NO and send GEN with the transaction. The amount the contract records is the value it actually received — never a number you typed.",
            },
            {
              n: "02",
              t: "GenLayer decides",
              d: "At the market's predetermined instant, validators independently fetch its bound sources and must agree on the outcome and on the record of what they read.",
            },
            {
              n: "03",
              t: "The contract settles",
              d: "Winners claim from the pool. The contract computes each payout from its own ledger; this interface only displays it.",
            },
          ].map((s) => (
            <div key={s.n} className="bg-ink-raised p-6 relative">
              <span className="absolute top-0 left-0 h-[2px] w-8 bg-amber" />
              <div className="tnum text-amber text-[12px]">{s.n}</div>
              <h3 className="mt-3 text-[16px] font-medium tracking-tight">{s.t}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-bone-dim">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why GenLayer */}
      <section className="mx-auto max-w-[1180px] px-5 pb-16">
        <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr] items-stretch">
          <Panel className="p-7" tick>
            <Label>Why this needs GenLayer</Label>
            <h2 className="mt-3 text-[24px] font-display font-semibold tracking-tight leading-tight">
              When two agents disagree about the real world, who decides?
            </h2>
            <div className="mt-4 space-y-3.5 text-[13.5px] leading-relaxed text-bone-dim">
              <p>
                A deterministic contract cannot answer questions whose truth
                lives outside the chain. Someone has to read the evidence. The
                moment that someone is a server, an admin key, or the party
                holding the money, the market is only as trustworthy as they are.
              </p>
              <p>
                AgentBet gives that job to GenLayer&apos;s validators. They fetch
                the evidence independently and have to <em>agree</em> — on the
                outcome, and on the record of what they read. No participant,
                including whoever created the market, can edit those sources.
              </p>
              <p className="text-bone border-l-2 border-amber pl-4">
                And when the evidence cannot establish the answer, nobody wins.
                The market becomes refundable and every stake goes back. A market
                that pays somebody regardless is just a coin flip with extra
                steps.
              </p>
            </div>
          </Panel>

          <div className="border border-ink-line divide-y divide-ink-line">
            {[
              ["Escrow is real", "Stakes are held by the contract. There is no withdraw function, and the creator has no lever over the money once anyone has staked."],
              ["Sources are not editable", "A market creator picks a subject, not a URL. The endpoints are contract constants run by independent operators."],
              ["Evidence is recorded", "Every fetch is stored with a hash over the exact bytes kept, so the record can be re-checked later by anyone."],
              ["Failure refunds", "Unreachable sources, feeds that disagree, or an inconclusive finding all resolve to UNRESOLVED — which pays no one."],
            ].map(([t, d]) => (
              <div key={t} className="bg-ink-raised p-5 hover:bg-ink-panel transition-colors">
                <h3 className="text-[13px] font-medium text-bone">{t}</h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-bone-dim">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
