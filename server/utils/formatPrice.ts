/** Safe price formatting — never throws on null/undefined/NaN. */
export function fmtPrice(value: unknown, decimals = 2): string {
  const n = toPriceNumber(value, NaN);
  return Number.isFinite(n) ? n.toFixed(decimals) : "—";
}

export function toPriceNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
