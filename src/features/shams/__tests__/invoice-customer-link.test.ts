/**
 * Invoice → customer enrichment: what must never happen.
 *
 * These tests are mostly negative, and deliberately so. The risk this module
 * carries is not that it fails to show a customer — it is that it shows the
 * **wrong** one on a document belonging to someone else. So the assertions are
 * about restraint: no link without the CRM having stated one, and no link that
 * crosses a branch boundary.
 *
 * The first test is the evidence for the whole design. It runs against the
 * captured `sales/details` header row and asserts that nothing in it can
 * identify a person — which is why enrichment has to be handed down from a CRM
 * search rather than looked up from an invoice.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { RawSalesRow, ShamsCrmCustomer } from "@/lib/shams/types";
import {
  _clearInvoiceCustomerLinks,
  recallInvoiceCustomer,
  rememberInvoiceCustomer,
} from "@/features/shams/invoice-customer-link";

/**
 * The captured `sales/details` header row for document 22635 at P0215.
 *
 * Verbatim — nothing in it identifies a person, which is the point being
 * asserted. `SAMI` on the CRM side is a placeholder for the real name the
 * capture holds; see `crm-history.test.ts`.
 */
const CAPTURED_HEADER: RawSalesRow = {
  Usr_ID: "3282",
  Doc_No: "22635",
  Doc_Dt: "2026-07-03 00:00:00",
  Doc_type: "Cash",
  PatCd: undefined,
  CusName: "",
  Customer: "",
  Customer_Name: "CASH IN BOX-",
  Customer_Code: "14-00-0052",
  Whouse: "P0215",
  Prior: "0",
  GrandAmt: "1261.400",
};

const SAMI: ShamsCrmCustomer = {
  customerId: "333181",
  name: "SAMI",
  mobile: "0555555555",
  availablePoints: 1261.4,
  pointsValue: 12.614,
};

beforeEach(() => {
  _clearInvoiceCustomerLinks();
});

describe("the invoice API cannot identify a customer", () => {
  it("returns no mobile number on any customer-ish field", () => {
    // Every field `sales/details` offers for "who is this", checked against the
    // number the CRM holds for this exact document. If a future capture ever
    // makes one of these a mobile number, this test fails and the enrichment
    // strategy can be revisited on evidence.
    const candidates = [
      CAPTURED_HEADER.PatCd,
      CAPTURED_HEADER.CusName,
      CAPTURED_HEADER.Customer,
      CAPTURED_HEADER.Customer_Name,
      CAPTURED_HEADER.Customer_Code,
      CAPTURED_HEADER.Cus_Cd,
    ];

    for (const value of candidates) {
      expect(value ?? "").not.toMatch(/\d{9}/);
    }
  });

  it("identifies a till, not a person", () => {
    // `CASH IN BOX-` is the account the sale rang through. The CRM says the
    // buyer was SAMI. The two do not resemble each other, which is exactly
    // why one cannot be derived from the other.
    expect(CAPTURED_HEADER.Customer_Name).toBe("CASH IN BOX-");
    expect(CAPTURED_HEADER.Customer_Name).not.toContain(SAMI.name);
  });
});

describe("a customer is shown only where the CRM put one", () => {
  it("recalls nothing for a document nobody has linked", () => {
    expect(recallInvoiceCustomer("P0215", "22635")).toBeNull();
  });

  it("recalls the customer for the exact document the CRM named", () => {
    rememberInvoiceCustomer("P0215", "22635", SAMI);
    expect(recallInvoiceCustomer("P0215", "22635")).toEqual(SAMI);
  });

  it("does not carry a customer across branches", () => {
    // The failure this prevents: document numbers repeat across warehouses, so
    // a number-only key would attach a Jeddah customer to a Riyadh sale.
    rememberInvoiceCustomer("P0215", "22635", SAMI);
    expect(recallInvoiceCustomer("P0304", "22635")).toBeNull();
  });

  it("does not carry a customer across document numbers", () => {
    rememberInvoiceCustomer("P0215", "22635", SAMI);
    expect(recallInvoiceCustomer("P0215", "22636")).toBeNull();
  });

  it("treats a zero-padded number as the same document", () => {
    rememberInvoiceCustomer("P0215", "22635", SAMI);
    expect(recallInvoiceCustomer("P0215", "022635")).toEqual(SAMI);
  });

  it("matches a branch code regardless of case", () => {
    // The CRM label carries `P0215`; `sales/details` echoes `Whouse` and the
    // capture shows the portal itself querying `wh_cd=p0215`.
    rememberInvoiceCustomer("p0215", "22635", SAMI);
    expect(recallInvoiceCustomer("P0215", "22635")).toEqual(SAMI);
  });

  it.each([
    ["no branch", null, "22635"],
    ["no document", "P0215", null],
  ])("stores nothing when the CRM row had %s", (_label, branch, doc) => {
    rememberInvoiceCustomer(branch, doc, SAMI);
    expect(recallInvoiceCustomer("P0215", "22635")).toBeNull();
  });

  it("stores nothing when there is no customer to store", () => {
    rememberInvoiceCustomer("P0215", "22635", null);
    expect(recallInvoiceCustomer("P0215", "22635")).toBeNull();
  });
});
