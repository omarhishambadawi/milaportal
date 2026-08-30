/**
 * The list's Date and time column.
 *
 * Two lines, two different columns of the row: `order_date` above,
 * `created_at` below. The split is not cosmetic — `order_date` is a Postgres
 * `date` and holds no hour at all, so the time can only come from the insert
 * timestamp, and that is a `timestamptz`. Which brings the one hazard worth a
 * suite: the date is zoneless and the time is not.
 *
 * A `timestamptz` renders in whatever zone the formatter is given. Left to the
 * runtime's, the same order prints 09:00 to a reader in Riyadh and 08:00 to one
 * in Cairo — the drift `lib/timezone` exists to have ended. These tests run
 * with the machine's zone, whatever CI's happens to be, and still expect Riyadh,
 * so a formatter that quietly dropped the `timeZone` option would fail here
 * rather than in a screenshot from another country.
 */

import { describe, expect, it } from "vitest";

import { fmtOrderDateShort, fmtOrderTimeShort } from "../utils";

describe("fmtOrderTimeShort", () => {
  it("renders the stored instant as Riyadh clock time", () => {
    // 11:45 UTC is 14:45 in Riyadh (UTC+3, no DST).
    expect(fmtOrderTimeShort("2026-08-30T11:45:00Z")).toBe("02:45 PM");
  });

  it("pads the hour so the column stays aligned", () => {
    // The reason for `hour: "2-digit"` where the activity timeline uses a bare
    // one: this value sits under a fixed-width `dd/MM/yy` in a tabular column.
    expect(fmtOrderTimeShort("2026-08-30T06:05:00Z")).toBe("09:05 AM");
    expect(fmtOrderTimeShort("2026-08-30T06:05:00Z")).toHaveLength(8);
    expect(fmtOrderTimeShort("2026-08-30T11:45:00Z")).toHaveLength(8);
  });

  it("names both halves of the day", () => {
    expect(fmtOrderTimeShort("2026-08-30T05:00:00Z")).toBe("08:00 AM");
    expect(fmtOrderTimeShort("2026-08-30T17:00:00Z")).toBe("08:00 PM");
  });

  it("prints midnight and noon as 12, not 00", () => {
    // 21:00 UTC is 00:00 the next day in Riyadh — the case `hour12` gets wrong
    // if it is spelled `hourCycle: "h11"`.
    expect(fmtOrderTimeShort("2026-08-30T21:00:00Z")).toBe("12:00 AM");
    expect(fmtOrderTimeShort("2026-08-30T09:00:00Z")).toBe("12:00 PM");
  });

  it("crosses the day boundary in Riyadh, not in UTC", () => {
    // A 22:30 Riyadh order is stored as 19:30 UTC the same day; a 01:30 Riyadh
    // order is stored as 22:30 UTC the day before. Both must read as the wall
    // clock the agent typed them at.
    expect(fmtOrderTimeShort("2026-08-30T19:30:00Z")).toBe("10:30 PM");
    expect(fmtOrderTimeShort("2026-08-29T22:30:00Z")).toBe("01:30 AM");
  });

  it("accepts the offset form PostgREST actually returns", () => {
    // Supabase serialises `timestamptz` with an offset rather than a `Z`, and
    // with microsecond precision. Same instant, same answer.
    expect(fmtOrderTimeShort("2026-08-30T11:45:27.974895+00:00")).toBe("02:45 PM");
    expect(fmtOrderTimeShort("2026-08-30T14:45:27.974895+03:00")).toBe("02:45 PM");
  });

  it("withholds rather than guesses when there is no timestamp", () => {
    // An em dash is what every other absent value in this table prints. The row
    // must render either way — this cell is not allowed to be the thing that
    // throws inside a 100-row map.
    expect(fmtOrderTimeShort(null)).toBe("—");
    expect(fmtOrderTimeShort(undefined)).toBe("—");
    expect(fmtOrderTimeShort("")).toBe("—");
    expect(fmtOrderTimeShort("not a timestamp")).toBe("—");
  });
});

describe("the two lines together", () => {
  it("keeps the date exactly as it was", () => {
    // The rename and the second line changed nothing about the first one.
    expect(fmtOrderDateShort("2026-08-30")).toBe("30/08/26");
    expect(fmtOrderDateShort(null)).toBe("—");
  });

  it("reads the date and the time from different fields", () => {
    // The pairing the cell renders, and the reason the column had to start
    // fetching `created_at`: `order_date` alone cannot answer the second line.
    const order = { order_date: "2026-08-30", created_at: "2026-08-30T11:45:00Z" };
    expect(fmtOrderDateShort(order.order_date)).toBe("30/08/26");
    expect(fmtOrderTimeShort(order.created_at)).toBe("02:45 PM");
  });

  it("lets a backdated order keep its own date above its entry time", () => {
    // ~0.5% of orders: entered the morning after the shift they belong to. The
    // date is the order's, the time is the keystroke's, and neither is adjusted
    // to agree with the other.
    const backdated = { order_date: "2026-08-29", created_at: "2026-08-30T06:05:00Z" };
    expect(fmtOrderDateShort(backdated.order_date)).toBe("29/08/26");
    expect(fmtOrderTimeShort(backdated.created_at)).toBe("09:05 AM");
  });
});
