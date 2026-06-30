/**
 * Non-blocking IBKR positions fetch — 15s cache, 5s timeout.
 * UI renders immediately; COVER/SELL units update when data arrives.
 */

export type IbkrPositionRow = {
  ticker?: string;
  symbol?: string;
  conid?: number | null;
  position?: number;
};

const CACHE_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;

let cached: { at: number; positions: IbkrPositionRow[] } | null = null;

export async function fetchIbkrPositionsCached(): Promise<IbkrPositionRow[]> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) {
    return cached.positions;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("/api/ibind/positions", { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { positions?: IbkrPositionRow[] };
    const positions = json.positions ?? [];
    cached = { at: Date.now(), positions };
    return positions;
  } catch {
    return cached?.positions ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export function matchTickerPosition(
  positions: IbkrPositionRow[],
  ticker: string,
): IbkrPositionRow | undefined {
  const tickerUp = ticker.toUpperCase();
  const tickerBase = tickerUp.replace(/\.TA$/, "");
  return positions.find((p) => {
    const sym = (p.ticker ?? p.symbol ?? "").toUpperCase();
    return sym === tickerUp || sym === tickerBase || sym.replace(/\.TA$/, "") === tickerBase;
  });
}

export function applyPositionMatch(
  match: IbkrPositionRow | undefined,
  setIbkrPosition: (p: { qty: number; side: "long" | "short" | null }) => void,
  setIbkrConid: (c: number) => void,
  existingConid?: number,
): void {
  if (match?.conid && match.conid > 0 && (!existingConid || existingConid <= 0)) {
    setIbkrConid(match.conid);
  }
  const posQty = Math.abs(Number(match?.position ?? 0));
  if (posQty > 0 && match) {
    const rawPos = Number(match.position ?? 0);
    setIbkrPosition({ qty: posQty, side: rawPos < 0 ? "short" : "long" });
  } else {
    setIbkrPosition({ qty: 0, side: null });
  }
}
