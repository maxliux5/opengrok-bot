import { describe, expect, it } from "vitest";
import { latestRoutineFire, nextRoutineFire } from "./routines.js";

describe("daily routine schedule", () => {
  it("uses the configured IANA time zone", () => {
    expect(nextRoutineFire("09:30", "Asia/Shanghai", new Date("2026-10-06T00:00:00Z"))
      .toISOString()).toBe("2026-10-06T01:30:00.000Z");
  });

  it("skips the missing wall-clock time during spring DST", () => {
    expect(nextRoutineFire("02:30", "Europe/Berlin", new Date("2026-03-28T02:00:00Z"))
      .toISOString()).toBe("2026-03-30T00:30:00.000Z");
  });

  it("runs once at the first repeated wall-clock time during fall DST", () => {
    const first = nextRoutineFire("01:30", "America/New_York",
      new Date("2026-11-01T04:00:00Z"));
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextRoutineFire("01:30", "America/New_York", first)
      .toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("coalesces a month of missed daily fires to the latest one", () => {
    expect(latestRoutineFire("09:30", "Asia/Shanghai", new Date("2026-10-06T02:00:00Z"))
      .toISOString()).toBe("2026-10-06T01:30:00.000Z");
  });
});
