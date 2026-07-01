import { describe, it, expect } from "vitest";
import { isTaseClosed, isTaseClosedToday } from "./marketHours";

describe("isTaseClosedToday vs isTaseClosed", () => {
  it("Wed 19:07 IL — RTH over but session happened today → closedToday=false, closed=false-ish", () => {
    // 2026-07-01 16:07 UTC = 19:07 Israel (UTC+3)
    const wedEvening = new Date("2026-07-01T16:07:00.000Z");
    expect(isTaseClosedToday(wedEvening)).toBe(false);
    expect(isTaseClosed(wedEvening)).toBe(true); // outside RTH hours
  });

  it("Saturday IL — no TASE session → closedToday=true", () => {
    const sat = new Date("2026-07-04T12:00:00.000Z"); // Sat 15:00 IL
    expect(isTaseClosedToday(sat)).toBe(true);
  });

  it("TASE holiday — closedToday=true", () => {
    const passover = new Date("2026-04-09T10:00:00.000Z"); // in TASE_HOLIDAYS 2026
    expect(isTaseClosedToday(passover)).toBe(true);
  });
});
