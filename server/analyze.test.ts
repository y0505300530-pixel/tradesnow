import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ─── Mock DB helpers ──────────────────────────────────────────────────────────

vi.mock("./db", () => ({
  createAnalysis: vi.fn().mockResolvedValue(42),
  getAnalysisById: vi.fn().mockResolvedValue({
    id: 42,
    userId: 1,
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    videoId: "dQw4w9WgXcQ",
    videoTitle: "Test Video",
    channelName: "Test Channel",
    thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    transcript: null,
    analysisResult: null,
    status: "processing",
    errorMessage: "step:metadata",
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  updateAnalysis: vi.fn().mockResolvedValue(undefined),
  getAnalysesByUser: vi.fn().mockResolvedValue([]),
}));

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<TrpcContext["user"]> = {}): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
      ...overrides,
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("analyze.validateUrl", () => {
  it("returns valid=true for a standard YouTube watch URL", async () => {
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.analyze.validateUrl({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(result.valid).toBe(true);
    expect(result.videoId).toBe("dQw4w9WgXcQ");
  });

  it("returns valid=true for a youtu.be short URL", async () => {
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.analyze.validateUrl({
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(result.valid).toBe(true);
    expect(result.videoId).toBe("dQw4w9WgXcQ");
  });

  it("returns valid=false for a non-YouTube URL", async () => {
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.analyze.validateUrl({
      url: "https://www.google.com",
    });
    expect(result.valid).toBe(false);
    expect(result.videoId).toBeNull();
  });

  it("returns valid=false for a random string", async () => {
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.analyze.validateUrl({ url: "not-a-url" });
    expect(result.valid).toBe(false);
  });
});

describe("analyze.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an analysisId for a valid YouTube URL", async () => {
    const { createAnalysis } = await import("./db");
    (createAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(42);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.analyze.start({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(result.analysisId).toBe(42);
  });

  it("throws BAD_REQUEST for an invalid YouTube URL", async () => {
    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.analyze.start({ url: "https://www.notyoutube.com/watch?v=abc" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("analyze.status", () => {
  it("returns the analysis record for the owning user", async () => {
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.analyze.status({ analysisId: 42 });
    expect(result.id).toBe(42);
    expect(result.status).toBe("processing");
  });

  it("throws NOT_FOUND when analysis belongs to a different user", async () => {
    const { getAnalysisById } = await import("./db");
    (getAnalysisById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 99,
      userId: 999, // different user
      videoUrl: "https://www.youtube.com/watch?v=abc",
      videoId: "abc",
      status: "done",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const caller = appRouter.createCaller(makeCtx({ id: 1 }));
    await expect(caller.analyze.status({ analysisId: 99 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("analyze.history", () => {
  it("returns an array of analyses for the current user", async () => {
    const { getAnalysesByUser } = await import("./db");
    (getAnalysesByUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, userId: 1, videoUrl: "https://youtube.com/watch?v=abc", status: "done" },
    ]);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.analyze.history();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
  });
});

describe("Supadata API key validation", () => {
  it("SUPADATA_API_KEY is configured in the environment", () => {
    // This test validates that the secret was properly injected
    const key = process.env.SUPADATA_API_KEY;
    expect(key).toBeDefined();
    expect(typeof key).toBe("string");
    expect(key!.length).toBeGreaterThan(10);
  });
});

// ─── Ziv Engine Decimal Score Tests ──────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { calcZivEngineScore, type Bar } from "./zivEngine";

function makeBars(count: number, opts: {
  trend?: "bull" | "bear";
  atDonchian?: boolean;
  nearEma50?: boolean;
  rsiRange?: "ideal" | "overbought" | "oversold";
  highVolume?: boolean;
} = {}): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  const trend = opts.trend ?? "bull";
  for (let i = 0; i < count; i++) {
    const delta = trend === "bull" ? 0.2 : -0.2;
    price = Math.max(1, price + delta);
    bars.push({
      date: `2024-${String(Math.floor(i / 30) + 1).padStart(2, "0")}-${String((i % 30) + 1).padStart(2, "0")}`,
      open: price - 0.1,
      high: opts.atDonchian && i === count - 1 ? price + 5 : price + 0.5,
      low: price - 0.5,
      close: opts.atDonchian && i === count - 1 ? price + 4.9 : price,
      volume: opts.highVolume ? 2000000 : 500000,
    });
  }
  return bars;
}

describe("Ziv Engine v1.148 — Decimal Score", () => {
  it("returns a number with up to 2 decimal places", () => {
    const bars = makeBars(250, { trend: "bull" });
    const result = calcZivEngineScore(bars);
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
    // Verify 2 decimal places
    const str = result.score.toString();
    const decimals = str.includes(".") ? str.split(".")[1].length : 0;
    expect(decimals).toBeLessThanOrEqual(2);
  });

  it("Gold Breakout tier scores >= 9.00", () => {
    const bars = makeBars(250, { trend: "bull", atDonchian: true, highVolume: true });
    const result = calcZivEngineScore(bars);
    expect(result.score).toBeGreaterThanOrEqual(9.00);
    expect(result.tier).toBe("Gold Breakout");
  });

  it("Trash tier scores <= 3.99", () => {
    const bars = makeBars(250, { trend: "bear" });
    const result = calcZivEngineScore(bars);
    expect(result.score).toBeLessThanOrEqual(3.99);
    expect(["No Signal", "No Data"]).toContain(result.tier);
  });

  it("high volume adds to decimal sub-score vs low volume", () => {
    const barsHigh = makeBars(250, { trend: "bull", highVolume: true });
    const barsLow = makeBars(250, { trend: "bull", highVolume: false });
    const scoreHigh = calcZivEngineScore(barsHigh).score;
    const scoreLow = calcZivEngineScore(barsLow).score;
    // High volume should score >= low volume (same base tier)
    expect(scoreHigh).toBeGreaterThanOrEqual(scoreLow);
  });

  it("score 10.00 is only returned when baseScore is 10 (bullish PA + breakout)", () => {
    // Build bars where last candle is a hammer at Donchian high
    const bars = makeBars(250, { trend: "bull" });
    // Modify last bar to be a hammer at Donchian high
    const last = bars[bars.length - 1];
    const donchianHigh = Math.max(...bars.slice(-20).map(b => b.high));
    bars[bars.length - 1] = {
      ...last,
      close: donchianHigh + 0.01,
      high: donchianHigh + 0.5,
      low: donchianHigh - 2.0,
      open: donchianHigh - 0.1,
    };
    const result = calcZivEngineScore(bars);
    // Should be 10.00 (bullish PA hammer + breakout)
    expect(result.score).toBe(10.00);
  });
});
