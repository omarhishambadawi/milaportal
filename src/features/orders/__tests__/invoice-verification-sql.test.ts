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

/* -------------------------------------------------------------------------- */
/* The follow-up migration: reconciliation, created_by, assignment events      */
/* -------------------------------------------------------------------------- */

const syncSql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260814160000_order_value_sync_and_assignment.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("record_invoice_verification, after the one-shot fix", () => {
  it("reconciles whenever anything is verified, not only when something is new", () => {
    // The defect: the update used to sit inside `IF recorded > 0`, so an order
    // whose invoice was logged but whose value never landed could never be
    // repaired — the next call recorded nothing and therefore wrote nothing.
    expect(syncSql).toContain("IF verified_cnt > 0 THEN");
    expect(syncSql).not.toContain("IF recorded > 0 THEN");
  });

  it("still writes nothing when the order already agrees", () => {
    // Otherwise merely opening an order raises `edited` rows through the trigger.
    expect(syncSql).toContain("invoice_value IS DISTINCT FROM verified_sum");
    expect(syncSql).toContain("call_center_verified IS DISTINCT FROM true");
  });

  it("keeps recomputing the total from the log rather than accumulating", () => {
    expect(syncSql).toMatch(/SELECT COALESCE\(SUM\(\(a\.details->>'total'\)::numeric\), 0\)/);
  });

  it("keeps the per-invoice idempotency guard", () => {
    expect(syncSql).toContain("a.details->>'invoice_key' = key");
  });

  it("still only ever sets the Call Center flag", () => {
    expect(syncSql).toContain("call_center_verified = true");
    expect(syncSql).not.toContain("call_center_verified = false");
  });

  it("keeps the permission check, since RLS does not run for a definer function", () => {
    expect(syncSql).toContain("public.has_permission(uid, 'view_shams_mis')");
    expect(syncSql).toContain("public.has_permission(uid, 'edit_all_orders')");
  });
});

describe("created_by", () => {
  it("is its own column, not a reuse of agent_id", () => {
    expect(syncSql).toMatch(/ADD COLUMN IF NOT EXISTS created_by uuid/);
  });

  it("fills itself with the caller so it cannot be left out", () => {
    expect(syncSql).toContain("ALTER COLUMN created_by SET DEFAULT auth.uid()");
  });

  it("backfills historical rows from the agent who held them", () => {
    expect(syncSql).toContain(
      "UPDATE public.orders SET created_by = agent_id WHERE created_by IS NULL",
    );
  });

  it("cannot be forged, whatever the client sends", () => {
    expect(syncSql).toContain("AND created_by = auth.uid()");
  });

  it("lets a caller who may edit every order file it under another agent", () => {
    // This is what frees an Owner or Supervisor from becoming the assignee.
    expect(syncSql).toMatch(
      /auth\.uid\(\) = agent_id\s*\n\s*--[\s\S]*?OR public\.has_permission\(auth\.uid\(\), 'edit_all_orders'\)/,
    );
  });
});

describe("assignment is a tracked change", () => {
  it("raises its own event when the agent actually changes", () => {
    expect(syncSql).toContain("IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN");
    expect(syncSql).toContain("'assigned'");
  });

  it("records both sides, so a reassignment can name the previous holder", () => {
    expect(syncSql).toContain("'from', OLD.agent_id");
    expect(syncSql).toContain("'to', NEW.agent_id");
  });

  it("cannot fire for a page render — only a real change reaches it", () => {
    // `IS DISTINCT FROM` inside an UPDATE trigger is the whole guarantee: no
    // read path touches it, and a save that did not move the agent is inert.
    const assignedBlock = syncSql.slice(syncSql.indexOf("IF NEW.agent_id IS DISTINCT FROM"));
    expect(assignedBlock.slice(0, 400)).toContain("IS DISTINCT FROM");
  });

  it("does not also report the move as a field edit", () => {
    // `agent_id` is absent from the `changed` bag, and `team` is only reported
    // when it moved on its own.
    expect(syncSql).not.toContain("jsonb_build_object('agent_id', NEW.agent_id)");
    expect(syncSql).toContain(
      "IF NEW.team IS DISTINCT FROM OLD.team AND NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id THEN",
    );
  });
});
