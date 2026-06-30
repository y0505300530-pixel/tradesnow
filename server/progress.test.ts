import { describe, it, expect } from "vitest";

// Mirror of the parseProgressCode logic from InstallProgressBar.tsx
function parseProgressCode(errorMessage: string | null | undefined, status: string) {
  if (status === "done") {
    return { stage: "stage5", pct: 100, action: "Report delivered to the Customer.", status: "done" };
  }
  if (status === "error") {
    return { stage: "stage1", pct: 0, action: errorMessage ?? "An error occurred.", status: "error" };
  }
  if (status === "pending") {
    return { stage: "stage1", pct: 0, action: "Queued — waiting to start...", status: "pending" };
  }

  if (errorMessage?.startsWith("progress:")) {
    const parts = errorMessage.split(":");
    const stage = parts[1] ?? "stage1";
    const pct = parseInt(parts[2] ?? "0", 10);
    const action = parts.slice(3).join(":");
    return { stage, pct, action, status: "processing" };
  }

  // Legacy step codes
  const legacyMap: Record<string, { stage: string; pct: number; action: string; status: string }> = {
    "step:metadata":            { stage: "stage1", pct: 8,  action: "Extracting raw video metadata...", status: "processing" },
    "step:transcript":          { stage: "stage1", pct: 15, action: "Locating caption tracks...", status: "processing" },
    "step:transcript_fallback": { stage: "stage1", pct: 17, action: "Activating Supadata fallback...", status: "processing" },
    "step:analysis":            { stage: "stage3", pct: 50, action: "Running AI analysis...", status: "processing" },
  };
  if (errorMessage && legacyMap[errorMessage]) return legacyMap[errorMessage];

  return { stage: "stage1", pct: 0, action: "Initializing...", status: "processing" };
}

describe("parseProgressCode", () => {
  it("returns 100% for done status", () => {
    const result = parseProgressCode(null, "done");
    expect(result.pct).toBe(100);
    expect(result.stage).toBe("stage5");
    expect(result.status).toBe("done");
  });

  it("returns error state for error status", () => {
    const result = parseProgressCode("Something went wrong", "error");
    expect(result.status).toBe("error");
    expect(result.pct).toBe(0);
    expect(result.action).toBe("Something went wrong");
  });

  it("returns pending state for pending status", () => {
    const result = parseProgressCode(null, "pending");
    expect(result.status).toBe("pending");
    expect(result.pct).toBe(0);
  });

  it("parses stage1 progress code at 0%", () => {
    const code = "progress:stage1:0:Initializing connection to YouTube...";
    const result = parseProgressCode(code, "processing");
    expect(result.stage).toBe("stage1");
    expect(result.pct).toBe(0);
    expect(result.action).toBe("Initializing connection to YouTube...");
    expect(result.status).toBe("processing");
  });

  it("parses stage2 progress code at 28%", () => {
    const code = "progress:stage2:28:Identifying Tickers and asset symbols...";
    const result = parseProgressCode(code, "processing");
    expect(result.stage).toBe("stage2");
    expect(result.pct).toBe(28);
    expect(result.action).toBe("Identifying Tickers and asset symbols...");
  });

  it("parses stage3 progress code at 65%", () => {
    const code = "progress:stage3:65:Running AI synthesis — building trade signal map...";
    const result = parseProgressCode(code, "processing");
    expect(result.stage).toBe("stage3");
    expect(result.pct).toBe(65);
    expect(result.action).toContain("trade signal map");
  });

  it("parses stage4 progress code at 80%", () => {
    const code = "progress:stage4:80:Adjusting proficiency levels based on new data...";
    const result = parseProgressCode(code, "processing");
    expect(result.stage).toBe("stage4");
    expect(result.pct).toBe(80);
  });

  it("parses stage5 progress code at 96%", () => {
    const code = "progress:stage5:96:Finalizing report for the Customer...";
    const result = parseProgressCode(code, "processing");
    expect(result.stage).toBe("stage5");
    expect(result.pct).toBe(96);
  });

  it("handles action text containing colons", () => {
    const code = "progress:stage3:70:Logic synthesis complete — 12 signals identified.";
    const result = parseProgressCode(code, "processing");
    expect(result.action).toBe("Logic synthesis complete — 12 signals identified.");
  });

  it("falls back to legacy step:metadata code", () => {
    const result = parseProgressCode("step:metadata", "processing");
    expect(result.stage).toBe("stage1");
    expect(result.pct).toBe(8);
  });

  it("falls back to legacy step:analysis code", () => {
    const result = parseProgressCode("step:analysis", "processing");
    expect(result.stage).toBe("stage3");
    expect(result.pct).toBe(50);
  });

  it("returns default initializing state for unknown code", () => {
    const result = parseProgressCode("something:unknown", "processing");
    expect(result.pct).toBe(0);
    expect(result.action).toBe("Initializing...");
  });

  it("returns default initializing state for null errorMessage during processing", () => {
    const result = parseProgressCode(null, "processing");
    expect(result.pct).toBe(0);
    expect(result.status).toBe("processing");
  });
});

describe("progressCode format", () => {
  it("generates correct format string", () => {
    const stage = "stage2";
    const pct = 35;
    const action = "Mapping entry zones and price levels...";
    const code = `progress:${stage}:${pct}:${action}`;
    const parsed = parseProgressCode(code, "processing");
    expect(parsed.stage).toBe(stage);
    expect(parsed.pct).toBe(pct);
    expect(parsed.action).toBe(action);
  });

  it("all 5 stages are parseable", () => {
    const stages = [
      { code: "progress:stage1:8:Extracting raw video metadata...", stage: "stage1", pct: 8 },
      { code: "progress:stage2:28:Identifying Tickers...", stage: "stage2", pct: 28 },
      { code: "progress:stage3:50:Correlating Fundamental Catalysts...", stage: "stage3", pct: 50 },
      { code: "progress:stage4:80:Adjusting proficiency levels...", stage: "stage4", pct: 80 },
      { code: "progress:stage5:96:Finalizing report...", stage: "stage5", pct: 96 },
    ];
    for (const s of stages) {
      const result = parseProgressCode(s.code, "processing");
      expect(result.stage).toBe(s.stage);
      expect(result.pct).toBe(s.pct);
    }
  });
});
