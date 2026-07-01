/**
 * Tier-1 perf QA invariants — documents byte-identical constraints for Layer 1.
 * Does NOT replace integration tests with populated 420 cache (see QA plan).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const liveEngineSrc = readFileSync(join(__dirname, "routers/liveEngine.ts"), "utf8");
const marketDataSrc = readFileSync(join(__dirname, "marketData.ts"), "utf8");
const warSrc = readFileSync(join(__dirname, "warEngine.ts"), "utf8");

describe("Tier-1 perf QA invariants", () => {
  it("#1 — NLV persist must not use a large $ gate (sizing reads DB totalNlv)", () => {
    expect(liveEngineSrc).toMatch(/updateLiveConfig\(ctx\.user\.id, \{ totalNlv: liveNlv \}\)/);
    expect(liveEngineSrc).not.toMatch(/totalNlv[\s\S]{0,120}> 50/);
  });

  it("#4 — sub-420 must NOT slice in-memory 420 cache (reverted — byte-identical bar count)", () => {
    expect(marketDataSrc).not.toMatch(/_cached420\.slice\(-days\)/);
    expect(marketDataSrc).not.toMatch(/getBarsFromCache\(ticker\)[\s\S]{0,80}slice\(-days\)/);
  });

  it("#3 — intel memo is sequential per ticker (no Promise.all on long+short intel)", () => {
    expect(warSrc).toMatch(/_intelMemo/);
    expect(warSrc).toMatch(/const _getIntel = async/);
    const tickerLoop = warSrc.slice(warSrc.indexOf("let _intelMemo"), warSrc.indexOf("let _intelMemo") + 4000);
    expect(tickerLoop).not.toMatch(/Promise\.all\([\s\S]*_getIntel/);
  });
});
