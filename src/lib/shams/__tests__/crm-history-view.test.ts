/**
 * Ordering and month grouping for a customer's purchase history.
 *
 * Two rules an agent reads straight off the screen — "newest first" and "this
 * lot is August" — so both are pure functions with tests rather than JSX that
 * happens to look right on the one history someone tried it with.
 *
 * The cases below are the ones that actually break: a month boundary, a year
 * boundary, several items on one invoice, a row the API dated badly, and a
 * response that arrives in no particular order.
 */

import { describe, expect, it } from "vitest";
import type { ShamsCrmSale } from "@/lib/shams/types";
import { sortSalesNewestFirst } from "@/lib/shams/normalize";
import {
  countInvoices,
  groupSalesByMonth,
  latestSaleDate,
  monthLabel,
  saleMonthKey,
} from "@/lib/shams/crm-history";

/** A history line. Only the fields these rules read are set. */
const sale = (
  docDate: string | null,
  docNo: string | null,
  itemCode = "10611030",
  branchCode: string | null = "P0215",
): ShamsCrmSale => ({
  docNo,
  docDate,
  branchCode,
  branchCity: "JEDDAH",
  branchLabel: "P0215-JEDDAH",
  itemCode,
  itemName: "MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA",
  quantity: 1,
});

describe("newest first", () => {
  it("orders a shuffled response by date, descending", () => {
    const sorted = sortSalesNewestFirst([
      sale("2026-06-02T00:00:00", "170001"),
      sale("2026-08-08T00:00:00", "179821"),
      sale("2026-07-31T00:00:00", "178670"),
    ]);

    expect(sorted.map((s) => s.docDate)).toEqual([
      "2026-08-08T00:00:00",
      "2026-07-31T00:00:00",
      "2026-06-02T00:00:00",
    ]);
  });

  it("orders same-day purchases by the later invoice", () => {
    const sorted = sortSalesNewestFirst([
      sale("2026-08-08T00:00:00", "179820"),
      sale("2026-08-08T00:00:00", "179821"),
    ]);
    expect(sorted.map((s) => s.docNo)).toEqual(["179821", "179820"]);
  });

  it("compares invoice numbers numerically, not as text", () => {
    // The bug a string sort produces: "9" after "10".
    const sorted = sortSalesNewestFirst([
      sale("2026-08-08T00:00:00", "9"),
      sale("2026-08-08T00:00:00", "10"),
    ]);
    expect(sorted.map((s) => s.docNo)).toEqual(["10", "9"]);
  });

  it("crosses a year boundary correctly", () => {
    const sorted = sortSalesNewestFirst([
      sale("2025-12-31T00:00:00", "1"),
      sale("2026-01-01T00:00:00", "2"),
    ]);
    expect(sorted.map((s) => s.docDate?.slice(0, 7))).toEqual(["2026-01", "2025-12"]);
  });

  it("puts undated rows last rather than dropping them", () => {
    const sorted = sortSalesNewestFirst([
      sale(null, "1"),
      sale("2026-08-08T00:00:00", "2"),
      sale(null, "3"),
    ]);
    expect(sorted).toHaveLength(3);
    expect(sorted[0].docDate).toBe("2026-08-08T00:00:00");
    expect(sorted.slice(1).every((s) => s.docDate === null)).toBe(true);
  });

  it("does not mutate the array it was given", () => {
    const input = [sale("2026-06-02T00:00:00", "1"), sale("2026-08-08T00:00:00", "2")];
    sortSalesNewestFirst(input);
    expect(input[0].docNo).toBe("1");
  });
});

describe("month keys and labels", () => {
  it("reads the month off the ISO string without constructing a Date", () => {
    // Through `Date`, a timezone-less midnight moves a day — and with it a
    // purchase into the previous month — for anyone west of Riyadh.
    expect(saleMonthKey(sale("2026-08-01T00:00:00", "1"))).toBe("2026-08");
    expect(saleMonthKey(sale("2026-01-31T00:00:00", "1"))).toBe("2026-01");
  });

  it("reports no month for an undated row", () => {
    expect(saleMonthKey(sale(null, "1"))).toBeNull();
  });

  it.each([
    ["2026-08", "August 2026"],
    ["2026-01", "January 2026"],
    ["2025-12", "December 2025"],
  ])("%s → %s", (key, label) => {
    expect(monthLabel(key)).toBe(label);
  });
});

describe("grouping by month", () => {
  const history = sortSalesNewestFirst([
    sale("2026-08-08T00:00:00", "179821", "A"),
    sale("2026-08-08T00:00:00", "179820", "B"),
    sale("2026-08-05T00:00:00", "179700", "C"),
    sale("2026-07-31T00:00:00", "178670", "D"),
    sale("2026-07-21T00:00:00", "177179", "E"),
    sale("2026-06-02T00:00:00", "170001", "F"),
  ]);

  it("produces months newest first, following the order it was given", () => {
    expect(groupSalesByMonth(history).map((m) => m.label)).toEqual([
      "August 2026",
      "July 2026",
      "June 2026",
    ]);
  });

  it("keeps purchases newest-first inside each month", () => {
    const august = groupSalesByMonth(history)[0];
    expect(august.sales.map((s) => s.docDate)).toEqual([
      "2026-08-08T00:00:00",
      "2026-08-08T00:00:00",
      "2026-08-05T00:00:00",
    ]);
  });

  it("duplicates nothing — every row lands in exactly one month", () => {
    const grouped = groupSalesByMonth(history);
    const codes = grouped.flatMap((m) => m.sales.map((s) => s.itemCode));
    expect(codes).toHaveLength(history.length);
    expect(new Set(codes).size).toBe(history.length);
  });

  it("assumes no particular months and skips ones with nothing in them", () => {
    // A customer who bought in August and in February produces two headings,
    // not twelve.
    const sparse = sortSalesNewestFirst([
      sale("2026-08-08T00:00:00", "1"),
      sale("2026-02-02T00:00:00", "2"),
    ]);
    expect(groupSalesByMonth(sparse).map((m) => m.label)).toEqual(["August 2026", "February 2026"]);
  });

  it("collects undated rows into one trailing group rather than dropping them", () => {
    const withUndated = sortSalesNewestFirst([
      sale("2026-08-08T00:00:00", "1"),
      sale(null, "2"),
      sale(null, "3"),
    ]);
    const grouped = groupSalesByMonth(withUndated);
    expect(grouped.map((m) => m.label)).toEqual(["August 2026", "Undated"]);
    expect(grouped[1].sales).toHaveLength(2);
  });

  it("counts invoices per month, not rows", () => {
    // 179821 and 179820 are two documents; the August group has three lines.
    const august = groupSalesByMonth(history)[0];
    expect(august.sales).toHaveLength(3);
    expect(august.invoices).toBe(3);
  });

  it("returns nothing for an empty page rather than an empty heading", () => {
    expect(groupSalesByMonth([])).toEqual([]);
  });
});

describe("counting invoices", () => {
  it("folds a multi-item purchase into one invoice", () => {
    const lines = [
      sale("2026-08-08T00:00:00", "179821", "A"),
      sale("2026-08-08T00:00:00", "179821", "B"),
      sale("2026-08-08T00:00:00", "179821", "C"),
    ];
    expect(lines).toHaveLength(3);
    expect(countInvoices(lines)).toBe(1);
  });

  it("keeps the same number at two branches apart", () => {
    // Document numbers repeat across warehouses — merging them would report two
    // different sales as one.
    expect(
      countInvoices([
        sale("2026-08-08T00:00:00", "22635", "A", "P0215"),
        sale("2026-08-08T00:00:00", "22635", "A", "P0304"),
      ]),
    ).toBe(2);
  });

  it("counts a line with no document number as its own", () => {
    expect(countInvoices([sale("2026-08-08T00:00:00", null), sale(null, null)])).toBe(2);
  });
});

describe("latest purchase", () => {
  it("finds the most recent date regardless of the order given", () => {
    expect(
      latestSaleDate([
        sale("2026-06-02T00:00:00", "1"),
        sale("2026-08-08T00:00:00", "2"),
        sale("2026-07-31T00:00:00", "3"),
      ]),
    ).toBe("2026-08-08T00:00:00");
  });

  it("is null when nothing carries a date", () => {
    expect(latestSaleDate([sale(null, "1")])).toBeNull();
    expect(latestSaleDate([])).toBeNull();
  });
});
