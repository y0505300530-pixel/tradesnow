import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit tests for daily position changes detection logic.
 * Tests the change detection algorithm that runs inside syncFromIbkr.
 */

// ── Test the detection logic as a pure function ──────────────────────────────

interface ExistingHolding {
  ticker: string;
  units: number;
  buyPrice: number;
  currentPrice: number | null;
}

interface IbkrPosition {
  ticker: string;
  position: number;
  avgCost: number;
  mktPrice: number;
  mktValue: number;
  unrealizedPnl: number;
}

type ChangeType = "opened" | "closed" | "increased" | "reduced";

interface DetectedChange {
  ticker: string;
  changeType: ChangeType;
  unitsBefore: number;
  unitsAfter: number;
  unitsDelta: number;
  avgPriceBefore: number | null;
  avgPriceAfter: number | null;
  marketPriceAtChange: number | null;
  realizedPnl: number | null;
}

/**
 * Pure function that mirrors the detection logic in syncFromIbkr.
 * Given existing DB holdings and incoming IBKR positions, returns detected changes.
 */
function detectPositionChanges(
  existing: ExistingHolding[],
  ibkrPositions: IbkrPosition[]
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const ibkrTickers = new Set(ibkrPositions.map(p => p.ticker.toUpperCase()));

  const existingByTicker: Record<string, ExistingHolding> = {};
  existing.forEach(h => { existingByTicker[h.ticker.toUpperCase()] = h; });

  // Check each IBKR position against existing
  for (const pos of ibkrPositions) {
    const ticker = pos.ticker.toUpperCase();
    const existingRow = existingByTicker[ticker];

    if (existingRow) {
      // Check if quantity changed
      const qtyChanged = Math.abs(existingRow.units - pos.position) > 0.001;
      if (qtyChanged) {
        const unitsBefore = existingRow.units;
        const unitsAfter = pos.position;
        const delta = unitsAfter - unitsBefore;
        const changeType: ChangeType = delta > 0 ? "increased" : "reduced";
        const realizedPnl = delta < 0
          ? (pos.mktPrice - (existingRow.buyPrice ?? pos.avgCost)) * Math.abs(delta)
          : null;
        changes.push({
          ticker,
          changeType,
          unitsBefore,
          unitsAfter,
          unitsDelta: delta,
          avgPriceBefore: existingRow.buyPrice,
          avgPriceAfter: pos.avgCost,
          marketPriceAtChange: pos.mktPrice,
          realizedPnl,
        });
      }
    } else {
      // New position — opened
      changes.push({
        ticker,
        changeType: "opened",
        unitsBefore: 0,
        unitsAfter: pos.position,
        unitsDelta: pos.position,
        avgPriceBefore: null,
        avgPriceAfter: pos.avgCost,
        marketPriceAtChange: pos.mktPrice,
        realizedPnl: null,
      });
    }
  }

  // Check for closed positions (in DB but not in IBKR)
  for (const h of existing) {
    if (!ibkrTickers.has(h.ticker.toUpperCase())) {
      const closedUnits = h.units;
      const realizedPnl = closedUnits > 0 && h.buyPrice
        ? ((h.currentPrice ?? h.buyPrice) - h.buyPrice) * closedUnits
        : null;
      changes.push({
        ticker: h.ticker.toUpperCase(),
        changeType: "closed",
        unitsBefore: closedUnits,
        unitsAfter: 0,
        unitsDelta: -closedUnits,
        avgPriceBefore: h.buyPrice,
        avgPriceAfter: null,
        marketPriceAtChange: h.currentPrice,
        realizedPnl,
      });
    }
  }

  return changes;
}

describe("Daily Position Changes Detection", () => {
  it("detects a newly opened position", () => {
    const existing: ExistingHolding[] = [];
    const ibkrPositions: IbkrPosition[] = [
      { ticker: "AAPL", position: 100, avgCost: 150, mktPrice: 155, mktValue: 15500, unrealizedPnl: 500 },
    ];

    const changes = detectPositionChanges(existing, ibkrPositions);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      ticker: "AAPL",
      changeType: "opened",
      unitsBefore: 0,
      unitsAfter: 100,
      unitsDelta: 100,
      avgPriceBefore: null,
      avgPriceAfter: 150,
      marketPriceAtChange: 155,
      realizedPnl: null,
    });
  });

  it("detects a closed position", () => {
    const existing: ExistingHolding[] = [
      { ticker: "TSLA", units: 50, buyPrice: 200, currentPrice: 250 },
    ];
    const ibkrPositions: IbkrPosition[] = [];

    const changes = detectPositionChanges(existing, ibkrPositions);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      ticker: "TSLA",
      changeType: "closed",
      unitsBefore: 50,
      unitsAfter: 0,
      unitsDelta: -50,
      avgPriceBefore: 200,
      avgPriceAfter: null,
      marketPriceAtChange: 250,
    });
    // Realized P&L: (250 - 200) * 50 = 2500
    expect(changes[0].realizedPnl).toBe(2500);
  });

  it("detects an increased position", () => {
    const existing: ExistingHolding[] = [
      { ticker: "MSFT", units: 30, buyPrice: 300, currentPrice: 310 },
    ];
    const ibkrPositions: IbkrPosition[] = [
      { ticker: "MSFT", position: 50, avgCost: 305, mktPrice: 310, mktValue: 15500, unrealizedPnl: 250 },
    ];

    const changes = detectPositionChanges(existing, ibkrPositions);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      ticker: "MSFT",
      changeType: "increased",
      unitsBefore: 30,
      unitsAfter: 50,
      unitsDelta: 20,
      avgPriceBefore: 300,
      avgPriceAfter: 305,
      marketPriceAtChange: 310,
      realizedPnl: null, // no realized P&L on increase
    });
  });

  it("detects a reduced position with realized P&L", () => {
    const existing: ExistingHolding[] = [
      { ticker: "NVDA", units: 100, buyPrice: 400, currentPrice: 500 },
    ];
    const ibkrPositions: IbkrPosition[] = [
      { ticker: "NVDA", position: 60, avgCost: 400, mktPrice: 500, mktValue: 30000, unrealizedPnl: 6000 },
    ];

    const changes = detectPositionChanges(existing, ibkrPositions);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      ticker: "NVDA",
      changeType: "reduced",
      unitsBefore: 100,
      unitsAfter: 60,
      unitsDelta: -40,
      avgPriceBefore: 400,
      avgPriceAfter: 400,
      marketPriceAtChange: 500,
    });
    // Realized P&L: (500 - 400) * 40 = 4000
    expect(changes[0].realizedPnl).toBe(4000);
  });

  it("detects no changes when positions are the same", () => {
    const existing: ExistingHolding[] = [
      { ticker: "GOOG", units: 25, buyPrice: 140, currentPrice: 145 },
    ];
    const ibkrPositions: IbkrPosition[] = [
      { ticker: "GOOG", position: 25, avgCost: 140, mktPrice: 145, mktValue: 3625, unrealizedPnl: 125 },
    ];

    const changes = detectPositionChanges(existing, ibkrPositions);

    expect(changes).toHaveLength(0);
  });

  it("detects multiple changes at once (open + close + increase)", () => {
    const existing: ExistingHolding[] = [
      { ticker: "META", units: 20, buyPrice: 300, currentPrice: 350 },
      { ticker: "AMZN", units: 10, buyPrice: 150, currentPrice: 180 },
    ];
    const ibkrPositions: IbkrPosition[] = [
      // META increased from 20 to 30
      { ticker: "META", position: 30, avgCost: 310, mktPrice: 350, mktValue: 10500, unrealizedPnl: 1200 },
      // AMZN is gone (closed)
      // NFLX is new (opened)
      { ticker: "NFLX", position: 15, avgCost: 600, mktPrice: 610, mktValue: 9150, unrealizedPnl: 150 },
    ];

    const changes = detectPositionChanges(existing, ibkrPositions);

    expect(changes).toHaveLength(3);

    const meta = changes.find(c => c.ticker === "META");
    expect(meta).toBeDefined();
    expect(meta!.changeType).toBe("increased");
    expect(meta!.unitsDelta).toBe(10);

    const amzn = changes.find(c => c.ticker === "AMZN");
    expect(amzn).toBeDefined();
    expect(amzn!.changeType).toBe("closed");
    expect(amzn!.unitsDelta).toBe(-10);
    // Realized P&L: (180 - 150) * 10 = 300
    expect(amzn!.realizedPnl).toBe(300);

    const nflx = changes.find(c => c.ticker === "NFLX");
    expect(nflx).toBeDefined();
    expect(nflx!.changeType).toBe("opened");
    expect(nflx!.unitsDelta).toBe(15);
  });

  it("handles case-insensitive ticker matching", () => {
    const existing: ExistingHolding[] = [
      { ticker: "aapl", units: 50, buyPrice: 150, currentPrice: 160 },
    ];
    const ibkrPositions: IbkrPosition[] = [
      { ticker: "AAPL", position: 50, avgCost: 150, mktPrice: 160, mktValue: 8000, unrealizedPnl: 500 },
    ];

    const changes = detectPositionChanges(existing, ibkrPositions);

    // Should detect no change since ticker is the same (case-insensitive)
    expect(changes).toHaveLength(0);
  });

  it("calculates negative realized P&L on loss", () => {
    const existing: ExistingHolding[] = [
      { ticker: "BABA", units: 100, buyPrice: 200, currentPrice: 150 },
    ];
    const ibkrPositions: IbkrPosition[] = [];

    const changes = detectPositionChanges(existing, ibkrPositions);

    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("closed");
    // Realized P&L: (150 - 200) * 100 = -5000
    expect(changes[0].realizedPnl).toBe(-5000);
  });
});
