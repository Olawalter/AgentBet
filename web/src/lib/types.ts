/** Shapes returned by the contract's view methods. The contract is the source
 * of truth for every one of these — nothing here is computed in the browser. */

export type MarketStatus =
  | "open"
  | "closed"
  | "finalized"
  | "refundable"
  | "settled"
  | "cancelled";

export type Outcome = "" | "YES" | "NO" | "UNRESOLVED";
export type Side = "YES" | "NO";
export type RuleKind = "SPOT_THRESHOLD" | "EVENT_CLAIM";

export interface Market {
  id: string;
  creator: string;
  question: string;
  description: string;
  rule_kind: RuleKind;
  subject: string;
  comparator: string;
  threshold_cents: string;
  threshold_text: string;
  condition_text: string;
  resolution_sources: string[];
  resolution_start: string;
  resolution_deadline: string;
  recovery_deadline: string;
  settlement_delay: string;
  claimable_at: string;
  status: MarketStatus;
  yes_total: string;
  no_total: string;
  escrow_total: string;
  escrow_remaining: string;
  final_outcome: Outcome;
  winning_positions: number;
  settled_positions: number;
  staker_count: number;
  created_at: string;
  closed_at: string;
  finalized_at: string;
}

export interface MarketSummary {
  id: string;
  question: string;
  rule_kind: RuleKind;
  subject: string;
  status: MarketStatus;
  final_outcome: Outcome;
  yes_total: string;
  no_total: string;
  escrow_total: string;
  staker_count: number;
  resolution_start: string;
  resolution_deadline: string;
}

export interface MarketPage {
  total: number;
  offset: number;
  count: number;
  items: MarketSummary[];
}

export interface Position {
  exists: boolean;
  market_id: string;
  participant: string;
  side?: Side;
  amount?: string;
  claimed?: boolean;
  payout?: string;
  is_winning?: boolean;
  market_status?: MarketStatus;
  final_outcome?: Outcome;
}

export interface Claimable {
  claimable: boolean;
  // winnings_pending: a winning position whose settlement delay is still
  // arming — the amount is known but the claim write would revert until
  // claimable_at. The view refuses to advertise what the contract refuses.
  kind: "none" | "refund" | "winnings" | "winnings_pending";
  amount: string;
  reason: string;
  claimable_at: string;
}

export interface SourceRow {
  url: string;
  readable: boolean;
  observed: string;
  excerpt: string;
  digest: string;
}

export interface Resolution {
  exists: boolean;
  market_id?: string;
  outcome?: Outcome;
  sufficient?: boolean;
  observed_summary?: string;
  reason?: string;
  /** When the resolve transaction ran (consensus clock). */
  resolved_at?: string;
  /** The predetermined instant the price was observed AT — equal to the
   * market's resolution_start for price markets, "0" for event markets. This
   * is the settlement datum; resolved_at is merely when someone pressed the
   * button. */
  observed_at?: string;
  row_count?: number;
  rows: SourceRow[];
}

export interface AgentStats {
  address: string;
  markets: number;
  correct: number;
  incorrect: number;
  staked_wei: string;
  won_wei: string;
  accuracy_bps: number;
}

export interface Config {
  price_subjects: string[];
  claim_source_domains: string[];
  settlement_delay: number;
  recovery_grace: number;
  min_stake_wei: string;
  min_market_window: number;
  price_tolerance_bps: number;
  market_count: number;
}

/** Transaction lifecycle. SUBMITTED is not FINALIZED and the UI must never
 * conflate them — a submitted transaction has moved no value yet. */
export type TxPhase =
  | "idle"
  | "awaiting_wallet"
  | "submitted"
  | "pending"
  | "finalized"
  | "failed";

export interface TxState {
  phase: TxPhase;
  hash?: string;
  error?: string;
  /** Classified reason for a failed write (see lib/tx.ts). Lets the UI render
   * "the resolution window has expired" as a distinct, explained state. */
  errorKind?: string;
  note?: string;
}
