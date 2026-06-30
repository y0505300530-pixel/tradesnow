import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import the module after mocking
async function importSplashRouter() {
  vi.resetModules();
  const mod = await import("./routers/splash");
  return mod.splashRouter;
}

describe("splash router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns fearAndGreed data from CNN API", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("dataviz.cnn.io")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              fear_and_greed: { score: 67.0, rating: "greed" },
            }),
        });
      }
      // Yahoo Finance mock for indices
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: {
                      regularMarketPrice: 5000,
                      chartPreviousClose: 4900,
                      regularMarketChange: 100,
                      regularMarketChangePercent: 2.04,
                    },
                  },
                ],
              },
            })
          ),
      });
    });

    const splashRouter = await importSplashRouter();
    // Access the procedure's resolver directly
    const resolver = (splashRouter as any)._def.procedures.getMarketData._def.resolver;
    const result = await resolver({ ctx: {}, input: undefined, path: "splash.getMarketData", type: "query", rawInput: undefined, meta: undefined });

    expect(result.fearAndGreed).toBeDefined();
    expect(result.fearAndGreed?.value).toBe(67);
    expect(result.fearAndGreed?.classification).toBe("Greed");
  });

  it("returns null fearAndGreed on fetch failure", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error("Network error")));

    const splashRouter = await importSplashRouter();
    const resolver = (splashRouter as any)._def.procedures.getMarketData._def.resolver;
    const result = await resolver({ ctx: {}, input: undefined, path: "splash.getMarketData", type: "query", rawInput: undefined, meta: undefined });

    expect(result.fearAndGreed).toBeNull();
    expect(result.ta35).toBeNull();
    expect(result.sp500).toBeNull();
    expect(result.nasdaq).toBeNull();
  });

  it("returns index data with correct change calculation", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("dataviz.cnn.io")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              fear_and_greed: { score: 47.0, rating: "neutral" },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: {
                      regularMarketPrice: 7398.93,
                      chartPreviousClose: 7337.11,
                      regularMarketChange: 61.82,
                      regularMarketChangePercent: 0.843,
                    },
                  },
                ],
              },
            })
          ),
      });
    });

    const splashRouter = await importSplashRouter();
    const resolver = (splashRouter as any)._def.procedures.getMarketData._def.resolver;
    const result = await resolver({ ctx: {}, input: undefined, path: "splash.getMarketData", type: "query", rawInput: undefined, meta: undefined });

    expect(result.sp500).toBeDefined();
    expect(result.sp500?.price).toBeCloseTo(7398.93, 1);
    expect(result.sp500?.changePercent).toBeCloseTo(0.843, 2);
  });
});
