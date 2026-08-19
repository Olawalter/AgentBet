/** Display helpers. These format what the contract already decided; none of
 * them computes a payout, an outcome, or an eligibility. */

export const WEI = 1_000_000_000_000_000_000n;

export function toGen(wei: string | bigint, dp = 4): string {
  const v = typeof wei === "bigint" ? wei : BigInt(wei || "0");
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / WEI;
  const frac = abs % WEI;
  const fracStr = frac.toString().padStart(18, "0").slice(0, dp).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${fracStr ? "." + fracStr : ""}`;
}

export function genToWei(input: string): bigint | null {
  const t = input.trim();
  if (!t || !/^\d*\.?\d*$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  if (frac.length > 18) return null;
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  try {
    return BigInt(whole || "0") * WEI + BigInt(padded || "0");
  } catch {
    return null;
  }
}

export function shortAddress(a?: string, size = 4): string {
  if (!a) return "—";
  return `${a.slice(0, 2 + size)}…${a.slice(-size)}`;
}

export function pct(part: string, total: string): number {
  const p = BigInt(part || "0");
  const t = BigInt(total || "0");
  if (t === 0n) return 0;
  return Number((p * 10000n) / t) / 100;
}

/** Implied probability the market is pricing for a side, from the pool split.
 * Purely descriptive of the stake distribution — it is not a payout. */
export function impliedPct(side: string, yes: string, no: string): number {
  const y = BigInt(yes || "0");
  const n = BigInt(no || "0");
  const total = y + n;
  if (total === 0n) return 50;
  const part = side === "YES" ? y : n;
  return Number((part * 10000n) / total) / 100;
}

export function fromEpoch(epoch: string | number): Date | null {
  const n = Number(epoch || 0);
  return n > 0 ? new Date(n * 1000) : null;
}

export function formatEpoch(epoch: string | number): string {
  const d = fromEpoch(epoch);
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function relativeTo(epoch: string | number, now = Date.now()): string {
  const d = fromEpoch(epoch);
  if (!d) return "—";
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const unit =
    mins < 60 ? `${mins}m` :
    mins < 1440 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
