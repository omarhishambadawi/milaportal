/**
 * CRM customer history — against the captured payload, not a hand-written one.
 *
 * `CAPTURED_ROW` below is the single `crm/data` row from the 2026-08-19 HAR,
 * structurally verbatim — including the two things about it that are easy to
 * "tidy" into a bug: the branch arrives under an **empty key**, and the points
 * field is spelled `Lm_Availbale_Points`. Both are the API's, and a refactor
 * that corrects either spelling would read `undefined` in production while
 * still passing a test written from memory. This one would fail.
 *
 * **The customer's name and mobile number are replaced with placeholders.** The
 * capture holds a real person's; the repository does not, by the same rule that
 * keeps the HAR itself out of it. Only those two values are substituted, and the
 * substitute keeps the format that matters — nine digits after normalization,
 * ten with the trunk zero — so every assertion below still exercises the real
 * shape.
 *
 * `shamsFetch` is stubbed, so nothing here touches the network and the exact
 * query the module builds is visible to assertions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawCrmRow } from "@/lib/shams/types";

const fetchMock = vi.fn();

vi.mock("@/lib/shams/client.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shams/client.server")>(
    "@/lib/shams/client.server",
  );
  return { ...actual, shamsFetch: (...args: unknown[]) => fetchMock(...args) };
});

const { getCustomerHistory, validateCrmHistoryQuery } = await import("@/lib/shams/crm.server");
const { groupCrmHistory, normalizeCrmMobile, parseCrmBranch } =
  await import("@/lib/shams/normalize");

/** The captured row. Structure is the capture's; name and mobile are placeholders. */
const CAPTURED_ROW: RawCrmRow = {
  Id: "333181",
  Name: "SAMI",
  Mobileno: "0555555555",
  Lm_Availbale_Points: "1261.400000",
  Lm_Availbale_Value: "12.614000",
  "": "P0215-JEDDAH",
  Customer: "CASH IN BOX",
  InvNo: "22635",
  InvDate: "2026-07-03 00:00:00",
  Itm_Cd: "10611030",
  Itm_Name: "MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA",
  Qty: "1.00",
};

/** The captured envelope: a real `pagination` block with null totals. */
const capturedResponse = (rows: RawCrmRow[], perPage = 100) => ({
  success: true,
  pagination: { page: 1, per_page: perPage, total: null, total_pages: null },
  parameters: { fromdt: "20260602", todt: "20260818", mobileno: "555555555" },
  count: rows.length,
  data: rows,
});

const QUERY = { mobile: "0555555555", fromDate: "20260602", toDate: "20260818" };

beforeEach(() => {
  fetchMock.mockReset();
});

/* -------------------------------------------------------------------------- */

describe("mobile numbers reach the wire in the captured form", () => {
  // The capture asked for `mobileno=555555555` and was answered with
  // `Mobileno: "0555555555"`. Nine digits, no trunk zero, is the query form.
  it.each([
    ["0555555555", "555555555"],
    ["555555555", "555555555"],
    ["+966555555555", "555555555"],
    ["00966555555555", "555555555"],
    ["966555555555", "555555555"],
    ["055-555-5555", "555555555"],
    ["+966 55 555 5555", "555555555"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeCrmMobile(input)).toBe(expected);
  });

  it.each([["", "  ", "abc", "12345", "0400885060", "05555555551"]].flat())(
    "rejects %p rather than asking the API about it",
    (input) => {
      expect(normalizeCrmMobile(input)).toBeNull();
    },
  );

  it("sends the normalized number, not what was typed", async () => {
    fetchMock.mockResolvedValue(capturedResponse([CAPTURED_ROW]));
    await getCustomerHistory({ ...QUERY, mobile: "+966 55 555 5555" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, query] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v2/crm/data");
    expect(query).toEqual({
      mobileno: "555555555",
      fromdt: "20260602",
      todt: "20260818",
      page: 1,
      per_page: 100,
    });
  });
});

describe("the branch under the empty key", () => {
  it("splits the captured label into a code and a city", () => {
    expect(parseCrmBranch("P0215-JEDDAH")).toEqual({
      branchCode: "P0215",
      branchCity: "JEDDAH",
      branchLabel: "P0215-JEDDAH",
    });
  });

  it("keeps a label it cannot split, but reports no code", () => {
    // No code means nothing downstream will try to open a document for the row,
    // which is the whole reason the two are separate fields.
    expect(parseCrmBranch("JEDDAH")).toEqual({
      branchCode: null,
      branchCity: null,
      branchLabel: "JEDDAH",
    });
  });

  it("reads the branch off the row's empty key", () => {
    const { sales } = groupCrmHistory([CAPTURED_ROW]);
    expect(sales[0].branchCode).toBe("P0215");
    expect(sales[0].branchCity).toBe("JEDDAH");
  });

  it("survives a row with no branch at all", () => {
    const { sales } = groupCrmHistory([{ ...CAPTURED_ROW, "": undefined }]);
    expect(sales[0].branchCode).toBeNull();
    expect(sales[0].branchLabel).toBeNull();
    // The purchase is still history even when it cannot be linked to a document.
    expect(sales[0].itemCode).toBe("10611030");
  });
});

describe("grouping the captured payload", () => {
  it("lifts one customer out of the repeated columns", () => {
    const { customer } = groupCrmHistory([CAPTURED_ROW]);
    expect(customer).toEqual({
      customerId: "333181",
      name: "SAMI",
      // As returned — with its leading zero, unlike the query.
      mobile: "0555555555",
      availablePoints: 1261.4,
      pointsValue: 12.61,
    });
  });

  it("reads one sale row per item line, unfolded", () => {
    const { sales } = groupCrmHistory([CAPTURED_ROW]);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toEqual({
      docNo: "22635",
      // No timezone is invented — the API supplies none.
      docDate: "2026-07-03T00:00:00",
      branchCode: "P0215",
      branchCity: "JEDDAH",
      branchLabel: "P0215-JEDDAH",
      itemCode: "10611030",
      itemName: "MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA",
      quantity: 1,
    });
  });

  it("keeps every line of a multi-item invoice rather than folding to a document", () => {
    // The mistake `groupInvoices` exists to prevent is the opposite one here:
    // these rows carry no document totals, so collapsing them would silently
    // drop the second item from the customer's history.
    const second: RawCrmRow = { ...CAPTURED_ROW, Itm_Cd: "10611031", Qty: "2.00" };
    const { customer, sales } = groupCrmHistory([CAPTURED_ROW, second]);

    expect(sales).toHaveLength(2);
    expect(sales.map((s) => s.itemCode)).toEqual(["10611030", "10611031"]);
    expect(sales[1].quantity).toBe(2);
    // One customer, not two, despite the columns repeating on both rows.
    expect(customer?.customerId).toBe("333181");
  });

  it("treats a number that matched nobody as data, not failure", async () => {
    // The captured shape for an unknown number: HTTP 200, count 0, empty data.
    fetchMock.mockResolvedValue(capturedResponse([]));
    const history = await getCustomerHistory(QUERY);

    expect(history.customer).toBeNull();
    expect(history.sales).toEqual([]);
    expect(history.hasMore).toBe(false);
  });
});

describe("paging without a total", () => {
  it("offers another page only when this one came back full", async () => {
    const rows = Array.from({ length: 25 }, () => CAPTURED_ROW);
    fetchMock.mockResolvedValue(capturedResponse(rows, 25));

    const history = await getCustomerHistory({ ...QUERY, perPage: 25 });
    expect(history.hasMore).toBe(true);
    expect(history.perPage).toBe(25);
  });

  it("stops at a short page", async () => {
    fetchMock.mockResolvedValue(capturedResponse([CAPTURED_ROW], 25));
    const history = await getCustomerHistory({ ...QUERY, perPage: 25 });
    expect(history.hasMore).toBe(false);
  });

  it("measures fullness against the size the API echoed, not the one requested", async () => {
    // If the endpoint ever clamps `per_page`, comparing against the request
    // would call every clamped page "short" and hide the rest of the history.
    const rows = Array.from({ length: 100 }, () => CAPTURED_ROW);
    fetchMock.mockResolvedValue(capturedResponse(rows, 100));

    const history = await getCustomerHistory({ ...QUERY, perPage: 50 });
    expect(history.hasMore).toBe(true);
    expect(history.perPage).toBe(100);
  });

  it("falls back to the requested size when the echo is missing", async () => {
    fetchMock.mockResolvedValue({ success: true, count: 1, data: [CAPTURED_ROW] });
    const history = await getCustomerHistory({ ...QUERY, perPage: 1 });
    expect(history.perPage).toBe(1);
    expect(history.hasMore).toBe(true);
  });

  it("asks for the page it was given", async () => {
    fetchMock.mockResolvedValue(capturedResponse([CAPTURED_ROW]));
    await getCustomerHistory({ ...QUERY, page: 3, perPage: 50 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ page: 3, per_page: 50 });
  });
});

describe("validation happens before the network", () => {
  it.each([
    ["a number that is not one", { ...QUERY, mobile: "12345" }],
    ["a date that is not YYYYMMDD", { ...QUERY, fromDate: "2026-06-02" }],
    ["a range that ends before it starts", { ...QUERY, fromDate: "20260818", toDate: "20260602" }],
  ])("rejects %s without calling the API", async (_label, query) => {
    await expect(getCustomerHistory(query)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps an oversized page size rather than passing it upstream", () => {
    expect(validateCrmHistoryQuery({ ...QUERY, perPage: 5000 }).perPage).toBe(100);
    expect(validateCrmHistoryQuery({ ...QUERY, perPage: 0 }).perPage).toBe(1);
    expect(validateCrmHistoryQuery({ ...QUERY, page: 0 }).page).toBe(1);
  });

  it("accepts a single-day window", () => {
    const q = validateCrmHistoryQuery({ ...QUERY, fromDate: "20260703", toDate: "20260703" });
    expect(q.fromDate).toBe("20260703");
    expect(q.toDate).toBe("20260703");
  });
});
