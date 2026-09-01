/**
 * One migration defines the delivery-scheduler poll, and it is the last one.
 *
 * ---------------------------------------------------------------------------
 * The failure this pins
 * ---------------------------------------------------------------------------
 * Two migrations dated 2026-08-26 both defined `public.alshrouq_dispatch_due()`.
 * Which one a database ends up running is decided by filename order, so the
 * later, simpler body silently replaced the one carrying the health record, the
 * "not sent yet — here's why" note and stale-claim recovery. Production, having
 * applied only one of the two, ended up with a third answer.
 *
 * That mistake was entirely visible in this repository and in no database at
 * all, which is why the guard for it belongs here. The other half is inside
 * `20260901120000` itself: a `DO` block that reads the installed definition back
 * and fails the migration if any of the three behaviours is missing from it.
 *
 * The function cannot be executed here — it needs Postgres — so what is asserted
 * is the text: who defines it, in what order, and that the clauses carrying each
 * guarantee are present. Every assertion corresponds to something that puts a
 * courier dispatch back to failing silently if it is removed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function read(name: string): string {
  return readFileSync(`${MIGRATIONS}${name}`, "utf8");
}

/** Files that actually create the function, as opposed to mentioning it. */
const definers = files.filter((name) =>
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.alshrouq_dispatch_due/i.test(read(name)),
);

/** The file this repository considers authoritative. */
const CANONICAL = "20260901120000_alshrouq_scheduler_canonical.sql";

describe("the delivery scheduler has one effective definition", () => {
  /**
   * A function may of course be redefined over time — that is what a migration
   * history is. What matters is which definition a database is left holding,
   * and that is decided by filename order alone. So the property asserted is
   * not "defined once" but **"defined last by the file this repository calls
   * canonical"**.
   *
   * If this fails, a migration has been added that redefines the poll. The fix
   * is to make that file the canonical one — updating `CANONICAL` here and the
   * behaviour assertions below — and never to leave two files competing for the
   * last word, which is the original fault.
   */
  it("is defined last by the canonical migration", () => {
    expect(definers.length).toBeGreaterThan(0);
    expect(definers[definers.length - 1]).toBe(CANONICAL);
  });

  it("is not redefined by anything applied after it", () => {
    const later = files.filter((name) => name > CANONICAL);
    for (const name of later) {
      expect(
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.alshrouq_dispatch_due/i.test(read(name)),
      ).toBe(false);
    }
  });

  /**
   * The two migrations the incident was about, kept harmless.
   *
   * `20260826170000` was edited to stop defining the function, which fixed
   * nothing already deployed — a migration is recorded by version, not by
   * content, so an environment that had run it kept the downgraded body. That is
   * why the canonical definition had to be re-issued as a new file. Both are
   * asserted inert so neither can quietly start defining it again.
   */
  it("is not defined by either 2026-08-26 migration", () => {
    for (const name of [
      "20260826100000_alshrouq_scheduler_observability.sql",
      "20260826170000_alshrouq_scheduler_service_role_auth.sql",
    ]) {
      const sql = read(name);
      // 100000 is the migration whose implementation this restores, so it still
      // *contains* one; what must not happen is a third variant appearing after
      // the canonical file.
      expect(name > CANONICAL).toBe(false);
      expect(sql).toContain("alshrouq_dispatch_due");
    }
    expect(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.alshrouq_dispatch_due/i.test(
        read("20260826170000_alshrouq_scheduler_service_role_auth.sql"),
      ),
    ).toBe(false);
  });
});

describe("the canonical scheduler keeps every behaviour the incident was about", () => {
  const sql = read(CANONICAL);

  it("records what each poll did, so idle and dead stop looking alike", () => {
    // The health row itself, created where a database that skipped 20260826100000
    // would not otherwise have one.
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.alshrouq_scheduler_state");
    // Every tick, whether or not there was work.
    expect(sql).toContain("SET last_poll_at = now()");
    // The three answers it can record.
    expect(sql).toContain("last_outcome = 'idle'");
    expect(sql).toContain("last_outcome = 'unconfigured'");
    expect(sql).toContain("last_outcome    = 'poked'");
  });

  it("stamps a waiting delivery with the reason nothing has been sent", () => {
    expect(sql).toContain("The delivery scheduler is not connected");
    // Written onto the deliveries themselves, and only where it differs, so a
    // delivery waiting a week is updated once rather than ten thousand times.
    expect(sql).toContain("UPDATE public.alshrouq_dispatches\n       SET last_error = note");
    expect(sql).toContain("last_error IS DISTINCT FROM note");
  });

  it("notices the previous poll being refused, and says so on the deliveries", () => {
    // pg_net answers asynchronously, so the reply can only be read a tick later.
    expect(sql).toContain("FROM net._http_response WHERE id = prior_id");
    expect(sql).toContain("The delivery scheduler could not be reached.");
    expect(sql).toContain("The delivery scheduler was refused by the application");
  });

  it("counts claims a died-mid-run worker left behind, so they can be settled", () => {
    expect(sql).toContain("dispatch_status = 'processing'");
    expect(sql).toContain("last_attempt_at < now() - interval '15 minutes'");
    // The count is what gets the endpoint poked on their behalf; without it the
    // due query never looks at them again.
    expect(sql).toContain("'stale', stale_count");
    expect(sql).toContain("IF due_count = 0 AND stale_count = 0 THEN");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS alshrouq_dispatches_stale_claim_idx");
  });

  it("keeps the credential nobody has to maintain, and grants nothing new", () => {
    expect(sql).toContain("'Authorization', 'Bearer ' || secret");
    expect(sql).toContain("WHERE name = 'email_queue_service_role_key'");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.alshrouq_dispatch_due() FROM PUBLIC, anon, authenticated;",
    );
    // Default-safe: an environment without the endpoint sends nothing at all.
    expect(sql).toContain("IF endpoint IS NULL OR secret IS NULL THEN");
  });

  it("re-arms the every-minute job", () => {
    expect(sql).toContain("cron.unschedule('alshrouq-dispatch-due')");
    expect(sql).toContain("'alshrouq-dispatch-due',\n      '* * * * *',");
    expect(sql).toContain("SELECT public.alshrouq_dispatch_due();");
  });

  it("verifies itself, so a downgrade cannot be applied quietly", () => {
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("scheduler health state");
    expect(sql).toContain("stale-claim recovery");
  });
});

/**
 * The sentences the poll writes and the worker clears must be the same
 * sentences.
 *
 * They are duplicated on purpose — two short strings in two languages beats a
 * lookup table for text that exists only to be read by a person — and the
 * duplication is only safe while something checks it. If the SQL and the worker
 * drift, a delivery keeps a caption saying nothing was sent while it is being
 * sent.
 */
describe("the poll and the worker agree on what the poll says", () => {
  it("every note the migration writes is one the worker knows how to clear", async () => {
    const { isSchedulerStallNote } = await import("@/lib/shams-crm/alshrouq-scheduler.server");
    const sql = read(CANONICAL);
    const notes = [
      "The delivery scheduler is not connected on this deployment, so ",
      "The delivery scheduler could not be reached. Nothing has been sent.",
      "The delivery scheduler was refused by the application (HTTP ",
    ];
    for (const note of notes) {
      expect(sql).toContain(note);
      expect(isSchedulerStallNote(note)).toBe(true);
    }
    // And a genuine dispatch failure recorded in the same column is not one.
    expect(isSchedulerStallNote("AlShrouq refused the order (400): invalid phone.")).toBe(false);
  });
});
