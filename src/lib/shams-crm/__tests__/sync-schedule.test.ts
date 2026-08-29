/**
 * The schedule calculation, asserted against real Riyadh wall-clock times.
 *
 * The three defaults — 15:00, 21:00 and 00:00 Asia/Riyadh — are three
 * independent daily slots, and the tests below are written to fail if anyone
 * ever "simplifies" them into an every-eight-hours interval: the gaps between
 * them are 6h, 3h and 15h, and nothing here would survive being made uniform.
 *
 * The midnight slot gets the most attention. `00:00` is where an off-by-one-day
 * bug lives, and where `hourCycle` differences turn midnight into hour 24.
 */

import { describe, expect, it } from "vitest";
import {
  CATCH_UP_GRACE_MS,
  evaluateSlot,
  formatLocalTime,
  nextOccurrence,
  nextRunFor,
  parseLocalTime,
  slotKinds,
  type ScheduleSlot,
} from "@/lib/shams-crm/sync-schedule";

const RIYADH = "Asia/Riyadh";

function slot(over: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id: "slot-1",
    enabled: true,
    localTime: "15:00",
    timeZone: RIYADH,
    syncStock: true,
    syncPromotions: true,
    nextDueAt: null,
    ...over,
  };
}

/** Riyadh is UTC+3, so 15:00 local is 12:00Z on the same date. */
const at = (iso: string) => new Date(iso);

describe("parseLocalTime", () => {
  it("accepts the forms the database and the UI produce", () => {
    expect(parseLocalTime("15:00")).toEqual({ hour: 15, minute: 0, second: 0 });
    expect(parseLocalTime("00:00:00")).toEqual({ hour: 0, minute: 0, second: 0 });
    expect(parseLocalTime("21:30")).toEqual({ hour: 21, minute: 30, second: 0 });
  });

  it("rejects impossible times rather than coercing them", () => {
    for (const bad of ["24:00", "12:60", "abc", "", null, undefined, "1500"]) {
      expect(parseLocalTime(bad as string)).toBeNull();
    }
  });
});

describe("nextOccurrence — the three default slots", () => {
  it("resolves 15:00 Riyadh to 12:00 UTC the same day when it is still ahead", () => {
    const next = nextOccurrence(slot({ localTime: "15:00" }), at("2026-08-29T06:00:00Z"));
    expect(next?.toISOString()).toBe("2026-08-29T12:00:00.000Z");
  });

  it("rolls 15:00 to tomorrow once today's has passed", () => {
    const next = nextOccurrence(slot({ localTime: "15:00" }), at("2026-08-29T12:00:01Z"));
    expect(next?.toISOString()).toBe("2026-08-30T12:00:00.000Z");
  });

  it("resolves 21:00 Riyadh to 18:00 UTC", () => {
    const next = nextOccurrence(slot({ localTime: "21:00" }), at("2026-08-29T06:00:00Z"));
    expect(next?.toISOString()).toBe("2026-08-29T18:00:00.000Z");
  });

  it("resolves 00:00 Riyadh to 21:00 UTC the PREVIOUS day", () => {
    /*
     * The one that catches day-arithmetic bugs. Midnight in Riyadh on 30 Aug is
     * 21:00Z on 29 Aug — so a scheduler reasoning in UTC dates would place it a
     * day late.
     */
    const next = nextOccurrence(slot({ localTime: "00:00" }), at("2026-08-29T18:30:00Z"));
    expect(next?.toISOString()).toBe("2026-08-29T21:00:00.000Z");
  });

  it("is strictly after, so a slot cannot re-fire on its own occurrence", () => {
    const exactly = at("2026-08-29T12:00:00Z");
    const next = nextOccurrence(slot({ localTime: "15:00" }), exactly);
    expect(next?.toISOString()).toBe("2026-08-30T12:00:00.000Z");
  });

  it("crosses a month boundary", () => {
    const next = nextOccurrence(slot({ localTime: "15:00" }), at("2026-08-31T12:30:00Z"));
    expect(next?.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    const next = nextOccurrence(slot({ localTime: "00:00" }), at("2026-12-31T21:30:00Z"));
    // 00:00 Riyadh on 1 Jan 2027 == 21:00Z on 31 Dec 2026 — already past, so the
    // next one is 2 Jan Riyadh == 21:00Z on 1 Jan.
    expect(next?.toISOString()).toBe("2027-01-01T21:00:00.000Z");
  });

  it("crosses a leap day", () => {
    const next = nextOccurrence(slot({ localTime: "15:00" }), at("2028-02-28T12:30:00Z"));
    expect(next?.toISOString()).toBe("2028-02-29T12:00:00.000Z");
  });
});

describe("the three defaults are independent daily times, not an interval", () => {
  const slots = [
    slot({ id: "a", localTime: "15:00" }),
    slot({ id: "b", localTime: "21:00" }),
    slot({ id: "c", localTime: "00:00" }),
  ];

  it("produces uneven gaps — proving this is not every-eight-hours", () => {
    const from = at("2026-08-29T06:00:00Z");
    const times = slots.map((s) => nextOccurrence(s, from)!.getTime()).sort((x, y) => x - y);

    const gapsHours = times.slice(1).map((t, i) => (t - times[i]) / 3_600_000);
    // 12:00Z (15:00 Riyadh 29th) → 18:00Z (21:00 Riyadh 29th) → 21:00Z (00:00 Riyadh 30th)
    expect(gapsHours).toEqual([6, 3]);
    expect(gapsHours).not.toEqual([8, 8]);
  });

  it("moving one slot leaves the others untouched", () => {
    const from = at("2026-08-29T06:00:00Z");
    const before = nextOccurrence(slots[1], from)!.toISOString();
    const moved = nextOccurrence(slot({ id: "a", localTime: "14:00" }), from)!.toISOString();
    expect(moved).toBe("2026-08-29T11:00:00.000Z");
    expect(nextOccurrence(slots[1], from)!.toISOString()).toBe(before);
  });
});

describe("slotKinds", () => {
  it("targets stock only, promotions only, or both", () => {
    expect(slotKinds(slot({ syncStock: true, syncPromotions: false }))).toEqual(["stock"]);
    expect(slotKinds(slot({ syncStock: false, syncPromotions: true }))).toEqual(["promotions"]);
    expect(slotKinds(slot())).toEqual(["stock", "promotions"]);
    expect(slotKinds(slot({ syncStock: false, syncPromotions: false }))).toEqual([]);
  });
});

describe("evaluateSlot", () => {
  const now = at("2026-08-29T12:00:30Z"); // 30s after the 15:00 Riyadh slot

  it("is due when the stored time has just passed", () => {
    const d = evaluateSlot(slot({ nextDueAt: "2026-08-29T12:00:00.000Z" }), true, now);
    expect(d.verdict).toBe("due");
    if (d.verdict === "due") {
      expect(d.occurrence.toISOString()).toBe("2026-08-29T12:00:00.000Z");
      expect(d.kinds).toEqual(["stock", "promotions"]);
      // Advanced to tomorrow, not to some intermediate arrears.
      expect(d.nextDueAt?.toISOString()).toBe("2026-08-30T12:00:00.000Z");
    }
  });

  it("is not due before its time, and does not rewrite the stored value", () => {
    const d = evaluateSlot(slot({ nextDueAt: "2026-08-29T18:00:00.000Z" }), true, now);
    expect(d.verdict).toBe("not_due");
    expect(d.nextDueAt?.toISOString()).toBe("2026-08-29T18:00:00.000Z");
  });

  it("global automation OFF prevents execution", () => {
    const d = evaluateSlot(slot({ nextDueAt: "2026-08-29T12:00:00.000Z" }), false, now);
    expect(d.verdict).toBe("not_due");
  });

  it("a disabled slot does not execute", () => {
    const d = evaluateSlot(
      slot({ enabled: false, nextDueAt: "2026-08-29T12:00:00.000Z" }),
      true,
      now,
    );
    expect(d.verdict).toBe("not_due");
  });

  it("a slot targeting nothing does not execute", () => {
    const d = evaluateSlot(
      slot({ syncStock: false, syncPromotions: false, nextDueAt: "2026-08-29T12:00:00.000Z" }),
      true,
      now,
    );
    expect(d.verdict).toBe("not_due");
  });

  it("a brand-new slot acquires a due time without running", () => {
    const d = evaluateSlot(slot({ nextDueAt: null }), true, now);
    expect(d.verdict).toBe("not_due");
    expect(d.nextDueAt?.toISOString()).toBe("2026-08-30T12:00:00.000Z");
  });

  it("still computes a preview time while automation is off", () => {
    // So the Control Center can show what *would* happen before switching on.
    const d = evaluateSlot(slot({ nextDueAt: null }), false, now);
    expect(d.nextDueAt).not.toBeNull();
  });
});

describe("catch-up", () => {
  it("runs once when less than two hours late, using the ORIGINAL occurrence", () => {
    const d = evaluateSlot(
      slot({ nextDueAt: "2026-08-29T12:00:00.000Z" }),
      true,
      at("2026-08-29T13:30:00Z"), // 90 minutes late
    );
    expect(d.verdict).toBe("due");
    if (d.verdict === "due") {
      expect(d.occurrence.toISOString()).toBe("2026-08-29T12:00:00.000Z");
    }
  });

  it("records a skip when more than two hours late", () => {
    const d = evaluateSlot(
      slot({ nextDueAt: "2026-08-29T12:00:00.000Z" }),
      true,
      at("2026-08-29T15:00:00Z"), // 3 hours late
    );
    expect(d.verdict).toBe("missed");
    if (d.verdict === "missed") {
      expect(d.occurrence.toISOString()).toBe("2026-08-29T12:00:00.000Z");
      expect(d.lateMs).toBeGreaterThan(CATCH_UP_GRACE_MS);
    }
  });

  it("never produces a burst after a long outage", () => {
    /*
     * Three days down. The slot must not work through seventy-two hours of
     * arrears: one skipped occurrence, then resume at the next real time.
     */
    const d = evaluateSlot(
      slot({ nextDueAt: "2026-08-26T12:00:00.000Z" }),
      true,
      at("2026-08-29T13:00:00Z"),
    );
    expect(d.verdict).toBe("missed");
    // Advanced past every intermediate day, straight to tomorrow.
    expect(d.nextDueAt?.toISOString()).toBe("2026-08-30T12:00:00.000Z");
  });

  it("treats the grace boundary as inclusive of running", () => {
    const d = evaluateSlot(
      slot({ nextDueAt: "2026-08-29T12:00:00.000Z" }),
      true,
      new Date(Date.parse("2026-08-29T12:00:00.000Z") + CATCH_UP_GRACE_MS),
    );
    expect(d.verdict).toBe("due");
  });
});

describe("nextRunFor", () => {
  const slots = [
    slot({ id: "a", localTime: "15:00" }),
    slot({ id: "b", localTime: "21:00" }),
    slot({ id: "c", localTime: "00:00" }),
  ];

  it("picks the soonest slot targeting that kind", () => {
    const next = nextRunFor("stock", slots, true, at("2026-08-29T06:00:00Z"));
    expect(next?.toISOString()).toBe("2026-08-29T12:00:00.000Z");
  });

  it("ignores slots that do not target the kind", () => {
    const stockOnly = [
      slot({ id: "a", localTime: "15:00", syncPromotions: false }),
      slot({ id: "b", localTime: "21:00", syncStock: false }),
    ];
    expect(
      nextRunFor("promotions", stockOnly, true, at("2026-08-29T06:00:00Z"))?.toISOString(),
    ).toBe("2026-08-29T18:00:00.000Z");
  });

  it("ignores disabled slots", () => {
    const partly = [
      slot({ id: "a", localTime: "15:00", enabled: false }),
      slot({ id: "b", localTime: "21:00" }),
    ];
    expect(nextRunFor("stock", partly, true, at("2026-08-29T06:00:00Z"))?.toISOString()).toBe(
      "2026-08-29T18:00:00.000Z",
    );
  });

  it("returns null when automation is off, rather than a time that will not happen", () => {
    expect(nextRunFor("stock", slots, false, at("2026-08-29T06:00:00Z"))).toBeNull();
  });
});

describe("formatLocalTime", () => {
  it("renders the defaults the way an administrator asked for them", () => {
    expect(formatLocalTime("15:00")).toBe("03:00 PM");
    expect(formatLocalTime("21:00")).toBe("09:00 PM");
    expect(formatLocalTime("00:00")).toBe("12:00 AM");
    expect(formatLocalTime("12:00")).toBe("12:00 PM");
    expect(formatLocalTime("09:30")).toBe("09:30 AM");
  });
});
