/**
 * The guarantees `record_invoice_verification` has to keep.
 *
 * The function cannot be executed here — it needs a database — so what is
 * asserted is that the clauses carrying its invariants are still in the
 * migration. Each one exists because removing it silently breaks something the
 * client relies on and no type checks:
 *
 *   * idempotence — a re-render, a refetch or a second agent must not record the
 *     same invoice twice, and the total must not inflate;
 *   * the same zero-stripping as `invoiceKey`, or `022138` and `22138` become
 *     two invoices and one document is counted twice;
 *   * a permission check, because SECURITY DEFINER means RLS does not run;
 *   * the flag is only ever set, never cleared, so a later MIS outage cannot
 *     un-verify an order.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invoiceKey } from "../invoice-verification";

const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260814140000_order_invoice_verification.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("record_invoice_verification", () => {
  it("skips an invoice the timeline already records", () => {
    expect(sql).toMatch(/CONTINUE WHEN EXISTS \(/);
    expect(sql).toContain("a.action = 'invoice_verified'");
    expect(sql).toContain("a.details->>'invoice_key' = key");
  });

  it("strips leading zeros the same way the client does", () => {
    expect(sql).toContain("ltrim(btrim(entry->>'invoice_no'), '0')");
    // The all-zeros case both sides have to agree on.
    expect(sql).toContain("IF key = '' THEN key := '0'; END IF;");
    expect(invoiceKey("000")).toBe("0");
    expect(invoiceKey("022138")).toBe("22138");
  });

  it("recomputes the total from the log instead of accumulating it", () => {
    // A repeated call therefore cannot inflate the order's value.
    expect(sql).toMatch(/SELECT COALESCE\(SUM\(\(a\.details->>'total'\)::numeric\), 0\)/);
    expect(sql).toContain("FROM public.order_activity a");
  });

  it("checks the caller may edit this order, since RLS does not run for it", () => {
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("public.is_active(uid)");
    expect(sql).toContain("public.has_permission(uid, 'edit_all_orders')");
    expect(sql).toContain("public.has_permission(uid, 'verify_all_orders')");
    // Shams data is being written onto the order, so Shams access is required.
    expect(sql).toContain("public.has_permission(uid, 'view_shams_mis')");
  });

  it("only ever sets the Call Center flag", () => {
    expect(sql).toContain("call_center_verified = true");
    expect(sql).not.toContain("call_center_verified = false");
  });

  it("writes nothing when there was nothing new to record", () => {
    // Otherwise a no-op call manufactures `edited` and `verification_changed`
    // rows through the orders trigger.
    expect(sql).toContain("IF recorded > 0 THEN");
  });

  it("marks its rows as automated and names the source", () => {
    expect(sql).toContain("'automated',     true");
    expect(sql).toContain("'source',        'MilaPortal / Shams MIS'");
  });

  it("is not executable anonymously", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_invoice_verification.*FROM PUBLIC, anon/,
    );
  });
});
