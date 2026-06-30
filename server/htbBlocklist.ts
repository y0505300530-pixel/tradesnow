// server/htbBlocklist.ts
// In-memory Hard-To-Borrow / no-fill cooldown. A short that is placed but never fills
// (entry cancelled with 0 fill) lands here so the War Engine stops re-spamming the broker
// with the same un-fillable locate every cycle. Memory-only by design — clears on restart.
const htbBlocklist = new Map<string, number>(); // TICKER -> expiry epoch ms
const HTB_COOLDOWN_MS = 60 * 60 * 1000;         // 1 hour

export function markHtb(ticker: string, now = Date.now()): void {
  if (!ticker) return;
  htbBlocklist.set(ticker.toUpperCase(), now + HTB_COOLDOWN_MS);
}

export function isHtbBlocked(ticker: string, now = Date.now()): boolean {
  const key = (ticker ?? "").toUpperCase();
  const exp = htbBlocklist.get(key);
  if (exp == null) return false;
  if (now >= exp) { htbBlocklist.delete(key); return false; } // expired → self-clean
  return true;
}

export function htbRemainingMin(ticker: string, now = Date.now()): number {
  const exp = htbBlocklist.get((ticker ?? "").toUpperCase());
  return exp ? Math.max(0, Math.ceil((exp - now) / 60000)) : 0;
}
