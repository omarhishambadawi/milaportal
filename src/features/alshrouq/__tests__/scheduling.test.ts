/**
 * Scheduling arithmetic and the countdown.
 *
 * Entirely pure. `scheduledCountdownAt` takes the clock as an argument, so the
 * behaviour is tested without fake timers or rendering — including the case that
 * matters most: a countdown must not keep ticking beside an order a worker has
 * already claimed.
 */

import { describe, expect, it, vi } from "vitest";
import {
  describeRemaining,
  formatScheduledFor,
  parseScheduleInput,
  IMMEDIATE_WINDOW_MS,
} from "@/features/alshrouq/scheduling";
import { scheduledCountdownAt } from "@/features/alshrouq/use-scheduled-countdown";

/** Riyadh is UTC+3, so 03:30 PM local is 12:30 UTC. */
const NOW = new Date("2026-08-21T09:00:00.000Z");

describe("parseScheduleInput", () => {
  it("converts Riyadh wall-clock to a canonical UTC instant", () => {
    const r = parseScheduleInput("2026-08-21", "03:30 PM", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.iso).toBe("2026-08-21T12:30:00.000Z");
    expect(r.timing).toBe("scheduled");
  });

  it("does not depend on the host timezone", () => {
    // The value is built with Date.UTC and a fixed offset, so this is a fact
    // about the input rather than about the machine running the test.
    const r = parseScheduleInput("2026-12-31", "11:45 PM", new Date("2026-01-01T00:00:00Z"));
    if (!r.ok) throw new Error("unreachable");
    expect(r.iso).toBe("2026-12-31T20:45:00.000Z");
  });

  it.each([
    ["12:00 AM", "2026-08-21T21:00:00.000Z"],
    ["12:00 PM", "2026-08-22T09:00:00.000Z"],
  ])("handles %s, the two the naive formula gets wrong", (time, expected) => {
    const r = parseScheduleInput("2026-08-22", time, NOW);
    if (!r.ok) throw new Error("unreachable");
    expect(r.iso).toBe(expected);
  });

  it.each(["3:30 pm", "03:30 PM", " 3:30 p.m. "])("accepts %s", (time) => {
    expect(parseScheduleInput("2026-08-21", time, NOW).ok).toBe(true);
  });

  it("rejects a time in the past", () => {
    const r = parseScheduleInput("2026-08-20", "03:30 PM", NOW);
    expect(r).toEqual({ ok: false, reason: "past" });
  });

  it("treats a time within the immediate window as immediate, not scheduled", () => {
    // The clock passes the chosen minute while the agent reads the
    // confirmation; that must not turn a "send now" into a scheduled order.
    const soon = new Date(NOW.getTime() + IMMEDIATE_WINDOW_MS - 1000);
    const hh = String(((soon.getUTCHours() + 3) % 24) % 12 || 12).padStart(2, "0");
    const mm = String(soon.getUTCMinutes()).padStart(2, "0");
    const suffix = (soon.getUTCHours() + 3) % 24 < 12 ? "AM" : "PM";
    const r = parseScheduleInput("2026-08-21", `${hh}:${mm} ${suffix}`, NOW);
    if (!r.ok) throw new Error("unreachable");
    expect(r.timing).toBe("immediate");
  });

  it.each([
    ["", "03:30 PM", "incomplete"],
    ["2026-08-21", "", "incomplete"],
    ["21/08/2026", "03:30 PM", "unparseable"],
    ["2026-08-21", "15:30", "unparseable"],
    ["2026-08-21", "13:30 PM", "unparseable"],
    ["2026-13-01", "03:30 PM", "unparseable"],
  ])("rejects (%s, %s) as %s", (date, time, reason) => {
    expect(parseScheduleInput(date, time, NOW)).toEqual({ ok: false, reason });
  });
});

describe("formatScheduledFor", () => {
  it("renders the stored instant in Riyadh, 12-hour", () => {
    expect(formatScheduledFor("2026-08-21T12:30:00.000Z")).toBe("Aug 21, 2026 · 03:30 PM");
  });

  it("rolls the date when the instant crosses midnight locally", () => {
    // 22:30 UTC is 01:30 the next day in Riyadh.
    expect(formatScheduledFor("2026-08-21T22:30:00.000Z")).toBe("Aug 22, 2026 · 01:30 AM");
  });

  it("returns null rather than a fake date for junk", () => {
    expect(formatScheduledFor(null)).toBeNull();
    expect(formatScheduledFor("not a date")).toBeNull();
  });
});

describe("describeRemaining", () => {
  it.each([
    [32_000, "32 seconds"],
    [1_000, "1 second"],
    [47 * 60_000, "47 minutes"],
    [60_000, "1 minute"],
    [2 * 3_600_000 + 3 * 60_000, "2 hours 3 minutes"],
    [3_600_000, "1 hour"],
    [26 * 3_600_000, "1 day 2 hours"],
    [0, "now"],
    [-5000, "now"],
  ])("%i ms reads as %s", (ms, expected) => {
    expect(describeRemaining(ms)).toBe(expected);
  });
});

describe("scheduledCountdownAt", () => {
  const target = "2026-08-21T12:30:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("counts down while the row is still waiting", () => {
    const c = scheduledCountdownAt(target, "scheduled", at("2026-08-21T10:27:00.000Z"));
    expect(c.state).toBe("waiting");
    expect(c.remainingLabel).toBe("2 hours 3 minutes");
    expect(c.scheduledLabel).toBe("Aug 21, 2026 · 03:30 PM");
  });

  it("reconstructs identically from the stored value alone", () => {
    // Same inputs, no local state anywhere: a refresh or another device shows
    // the same figure.
    const a = scheduledCountdownAt(target, "scheduled", at("2026-08-21T10:27:00.000Z"));
    const b = scheduledCountdownAt(target, "scheduled", at("2026-08-21T10:27:00.000Z"));
    expect(a).toEqual(b);
  });

  it("goes due when the moment passes, and never negative", () => {
    const c = scheduledCountdownAt(target, "scheduled", at("2026-08-21T12:31:00.000Z"));
    expect(c.state).toBe("due");
    expect(c.remainingMs).toBe(0);
  });

  /** A number ticking down beside an order already on its way is a lie. */
  it.each(["processing", "accepted", "failed", "indeterminate", "cancelled"])(
    "stops counting once the row is %s",
    (status) => {
      const c = scheduledCountdownAt(target, status, at("2026-08-21T10:00:00.000Z"));
      expect(c.state).toBe("inactive");
      expect(c.remainingMs).toBeNull();
      // The time it was scheduled for is still worth showing.
      expect(c.scheduledLabel).toBe("Aug 21, 2026 · 03:30 PM");
    },
  );

  it("is inactive when nothing is scheduled", () => {
    expect(scheduledCountdownAt(null, null, Date.now())).toEqual({
      state: "inactive",
      remainingMs: null,
      remainingLabel: null,
      scheduledLabel: null,
    });
  });

  it("is inactive for an unparseable stored value", () => {
    expect(scheduledCountdownAt("whenever", "scheduled", Date.now()).state).toBe("inactive");
  });
});

/**
 * The architectural guarantee, asserted as a fact about the module rather than
 * left as a comment: the countdown has no way to dispatch anything.
 */
describe("the countdown cannot dispatch", () => {
  it("makes no request as it crosses zero", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      for (const t of [
        "2026-08-21T12:29:59.000Z",
        "2026-08-21T12:30:00.000Z",
        "2026-08-21T12:30:01.000Z",
      ]) {
        scheduledCountdownAt("2026-08-21T12:30:00.000Z", "scheduled", Date.parse(t));
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns a plain value — nothing callable a caller could fire", () => {
    const c = scheduledCountdownAt("2026-08-21T12:30:00.000Z", "scheduled", Date.now());
    expect(Object.values(c).every((v) => typeof v !== "function")).toBe(true);
  });
});
