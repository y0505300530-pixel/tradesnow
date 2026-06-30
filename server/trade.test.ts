import { describe, it, expect } from "vitest";

// ─── Unit tests for trade scan logic ──────────────────────────────────────────

describe("Trade scan - ticker normalization", () => {
  const normalize = (raw: string[]) =>
    Array.from(new Set(raw.map((t) => t.trim().toUpperCase())));

  it("deduplicates tickers", () => {
    expect(normalize(["nvda", "NVDA", "nvda"])).toEqual(["NVDA"]);
  });

  it("uppercases all tickers", () => {
    expect(normalize(["aapl", "tsla", "amzn"])).toEqual(["AAPL", "TSLA", "AMZN"]);
  });

  it("trims whitespace", () => {
    expect(normalize([" NVDA ", "  AAPL"])).toEqual(["NVDA", "AAPL"]);
  });

  it("handles mixed case and spaces", () => {
    expect(normalize(["Nvda", " Aapl "])).toEqual(["NVDA", "AAPL"]);
  });
});

describe("Trade scan - ticker mention extraction", () => {
  const extractMentions = (
    tickers: string[],
    analyses: Array<{ analysisResult: string | null; videoTitle: string | null }>
  ) => {
    const tickerMentions: Record<string, Array<{ videoTitle: string; setup: Record<string, string> }>> = {};
    for (const ticker of tickers) tickerMentions[ticker] = [];

    for (const analysis of analyses) {
      if (!analysis.analysisResult) continue;
      try {
        const parsed = JSON.parse(analysis.analysisResult);
        const rows: Array<Record<string, string>> = Array.isArray(parsed)
          ? parsed
          : (parsed.rows ?? []);
        for (const row of rows) {
          const t = (row.ticker ?? "").toUpperCase().trim();
          if (tickers.includes(t)) {
            tickerMentions[t].push({
              videoTitle: analysis.videoTitle ?? "Unknown Video",
              setup: row,
            });
          }
        }
      } catch {
        // skip malformed
      }
    }
    return tickerMentions;
  };

  it("extracts mentions for matching tickers", () => {
    const result = extractMentions(["NVDA", "AAPL"], [
      {
        videoTitle: "Trading NVDA",
        analysisResult: JSON.stringify([{ ticker: "NVDA", entry_zone: "$180-$185", stop_loss: "$170" }]),
      },
    ]);
    expect(result["NVDA"]).toHaveLength(1);
    expect(result["NVDA"][0].setup.entry_zone).toBe("$180-$185");
    expect(result["AAPL"]).toHaveLength(0);
  });

  it("handles array-wrapped analysisResult", () => {
    const result = extractMentions(["TSLA"], [
      {
        videoTitle: "TSLA Setup",
        analysisResult: JSON.stringify([{ ticker: "TSLA", entry_zone: "$250" }]),
      },
    ]);
    expect(result["TSLA"]).toHaveLength(1);
  });

  it("handles rows-wrapped analysisResult", () => {
    const result = extractMentions(["AMZN"], [
      {
        videoTitle: "AMZN Analysis",
        analysisResult: JSON.stringify({ rows: [{ ticker: "AMZN", entry_zone: "$190" }] }),
      },
    ]);
    expect(result["AMZN"]).toHaveLength(1);
  });

  it("skips malformed JSON gracefully", () => {
    const result = extractMentions(["NVDA"], [
      { videoTitle: "Bad data", analysisResult: "not valid json" },
    ]);
    expect(result["NVDA"]).toHaveLength(0);
  });

  it("skips null analysisResult", () => {
    const result = extractMentions(["NVDA"], [
      { videoTitle: "No result", analysisResult: null },
    ]);
    expect(result["NVDA"]).toHaveLength(0);
  });
});

describe("Trade scan - JSON extraction from LLM response", () => {
  const extractJson = (content: string) => {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  };

  it("extracts clean JSON array", () => {
    const content = '[{"ticker":"NVDA","entryZone":"$180"}]';
    expect(extractJson(content)).toEqual([{ ticker: "NVDA", entryZone: "$180" }]);
  });

  it("extracts JSON from markdown fences", () => {
    const content = "```json\n[{\"ticker\":\"AAPL\",\"entryZone\":\"$190\"}]\n```";
    expect(extractJson(content)).toEqual([{ ticker: "AAPL", entryZone: "$190" }]);
  });

  it("returns null for non-JSON content", () => {
    expect(extractJson("No JSON here")).toBeNull();
  });

  it("handles multiline JSON", () => {
    const content = `[\n  {\n    "ticker": "TSLA",\n    "entryZone": "$250"\n  }\n]`;
    expect(extractJson(content)).toEqual([{ ticker: "TSLA", entryZone: "$250" }]);
  });
});

describe("Trade scan - confidence levels", () => {
  const isValidConfidence = (level: string) =>
    ["high", "medium", "low"].includes(level);

  it("accepts valid confidence levels", () => {
    expect(isValidConfidence("high")).toBe(true);
    expect(isValidConfidence("medium")).toBe(true);
    expect(isValidConfidence("low")).toBe(true);
  });

  it("rejects invalid confidence levels", () => {
    expect(isValidConfidence("very high")).toBe(false);
    expect(isValidConfidence("")).toBe(false);
  });
});
