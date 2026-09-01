/**
 * An order may have many AlShrouq dispatches over its life, and at most one live.
 *
 * ---------------------------------------------------------------------------
 * The failure this pins
 * ---------------------------------------------------------------------------
 * `alshrouq_dispatches` carried two unique indexes that were meant to say the
 * same thing and did not:
 *
 *     alshrouq_dispatches_live_order_key    UNIQUE (order_id) WHERE cancelled_at IS NULL
 *     alshrouq_dispatches_client_order_key  UNIQUE (client_order_id)      -- no predicate
 *
 * `client_order_id` is derived from the order's own display number and is
 * deliberately never invented per attempt, so the second index said "one
 * dispatch per order **ever**". An agent who cancelled a mistaken dispatch and
 * sent the order again got a courier booked at AlShrouq and a 23505 on the row
 * that was supposed to record it — a real delivery in motion with no record on
 * the order.
 *
 * The indexes cannot be exercised here — they need Postgres — so what is
 * asserted is that the corrective migration scopes the second one exactly as the
 * first, and that neither the original table migration nor anything after it
 * reintroduces a total unique index on either column.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const CORRECTIVE = "20260901130000_alshrouq_dispatch_history.sql";

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function read(name: string): string {
  return readFileSync(`${MIGRATIONS}${name}`, "utf8");
}

describe("the identity index counts live dispatches only", () => {
  const sql = read(CORRECTIVE);

  it("replaces the total index rather than adding a second one", () => {
    expect(sql).toContain("DROP INDEX IF EXISTS public.alshrouq_dispatches_client_order_key;");
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS alshrouq_dispatches_client_order_key\n" +
        "  ON public.alshrouq_dispatches (client_order_id)\n" +
        "  WHERE cancelled_at IS NULL;",
    );
  });

  /**
   * The predicate is the whole fix, and it is the *same* predicate the per-order
   * index already uses. Two indexes with different ideas of what counts as live
   * is what produced the incident; they now stand or fall together, and the
   * migration re-reads both from the catalog and refuses to apply if they
   * disagree.
   */
  it("verifies both indexes agree about what counts as live", () => {
    expect(sql).toContain("alshrouq_dispatches_live_order_key");
    expect(sql).toContain("live_pred IS DISTINCT FROM ident_pred");
    expect(sql).toContain("RAISE EXCEPTION");
  });

  it("is the last migration to touch either index", () => {
    const later = files.filter((name) => name > CORRECTIVE);
    for (const name of later) {
      const text = read(name);
      expect(text).not.toContain("alshrouq_dispatches_client_order_key");
      expect(text).not.toContain("alshrouq_dispatches_live_order_key");
    }
  });

  /**
   * Duplicate protection is not weakened, only scoped.
   *
   * While an uncancelled dispatch exists — `scheduled`, `processing`,
   * `accepted`, `failed` or `indeterminate` — a second row for that order is
   * still refused by both indexes. Only cancelled history stops blocking, which
   * is exactly what the per-order index was documented as allowing from the
   * day it was written.
   */
  it("leaves the per-order guarantee exactly as it was", () => {
    const original = read("20260820180000_alshrouq_dispatch.sql");
    expect(original).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS alshrouq_dispatches_live_order_key\n" +
        "  ON public.alshrouq_dispatches (order_id)\n" +
        "  WHERE cancelled_at IS NULL;",
    );
    // And the corrective migration does not touch it.
    expect(read(CORRECTIVE)).not.toContain(
      "DROP INDEX IF EXISTS public.alshrouq_dispatches_live_order_key",
    );
  });
});

/**
 * The application's own copy of the rule, checked against the database's.
 *
 * `blocksNewDispatch` is what the duplicate check and the order card ask, and it
 * has to mean the same thing as `cancelled_at IS NULL`. If these two ever part
 * company, one of them lets an order be sent twice.
 */
describe("the application agrees with the indexes", () => {
  it("treats every uncancelled state as owning the slot, and cancelled as not", async () => {
    const { ALSHROUQ_DISPATCH_STATUSES, blocksNewDispatch } =
      await import("@/lib/shams-crm/alshrouq-dispatch-state");
    for (const status of ALSHROUQ_DISPATCH_STATUSES) {
      expect(blocksNewDispatch(status)).toBe(status !== "cancelled");
    }
  });
});
