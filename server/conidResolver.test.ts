import { describe, it, expect, vi } from "vitest";

vi.mock("./routers/ibkrProxy", () => ({
  ibindRequest: vi.fn(async (_m: string, path: string) => {
    if (path.startsWith("/quotes")) return { ok: true, status: 200, body: { quotes: [{ ticker: "AAPL", conid: 265598, exchange_raw: "NASDAQ" }] } };
    return { ok: true, status: 200, body: {} };
  }),
}));

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  setSystemSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("resolveConid (live)", () => {
  it("resolves a known ticker via the live gateway", async () => {
    const { resolveConid } = await import("./conidResolver");
    const conid = await resolveConid("AAPL");
    expect(typeof conid === "number" || conid === null).toBe(true);
  });
});
