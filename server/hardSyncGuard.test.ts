import { describe, it, expect } from "vitest";
import { hardSyncMassDisappearanceGuard } from "./liveOrderExecutor";

describe("hardSyncMassDisappearanceGuard (mirror ibkrSync.ts:182-189)", () => {
  const four = ["AAPL", "GOOGL", "AMD", "NSC"];

  it("aborts on empty IBKR response with ≥3 DB opens (gateway blip)", () => {
    const r = hardSyncMassDisappearanceGuard(four, []);
    expect(r.abort).toBe(true);
    expect(r.missingCount).toBe(4);
    expect(r.missingPct).toBe(1);
  });

  it("does not abort when IBKR returns 3/4 tickers with records (normal partial)", () => {
    const ibkr = [
      { ticker: "AAPL", position: 10 },
      { ticker: "GOOGL", position: 5 },
      { ticker: "AMD", position: 8 },
    ];
    const r = hardSyncMassDisappearanceGuard(four, ibkr);
    expect(r.abort).toBe(false);
    expect(r.missingCount).toBe(1);
    expect(r.missingPct).toBe(0.25);
  });

  it("does not abort when <3 DB opens even if IBKR is empty", () => {
    const r = hardSyncMassDisappearanceGuard(["AAPL", "GOOGL"], []);
    expect(r.abort).toBe(false);
  });

  it("does not abort when all DB tickers appear in IBKR list (legitimate zero-qty records)", () => {
    const ibkr = four.map((t) => ({ ticker: t, position: 0 }));
    const r = hardSyncMassDisappearanceGuard(four, ibkr);
    expect(r.abort).toBe(false);
    expect(r.missingCount).toBe(0);
  });
});
