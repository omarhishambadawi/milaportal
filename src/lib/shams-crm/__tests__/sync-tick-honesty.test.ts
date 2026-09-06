/**
 * A tick that failed must not read like a tick that had nothing to do.
 *
 * ---------------------------------------------------------------------------
 * The report this is about
 * ---------------------------------------------------------------------------
 * The Shams background sync was reported as failing while "the scheduler still
 * reports a successful tick", the evidence being a summary reading
 * `catalogRefreshed=false, catalogRows=0, offerSweepComplete=false,
 * offerRowsChanged=0`.
 *
 * Those four values are exactly what an **idle** tick produced, and they were
 * also exactly what a **failed** one produced. `runShamsSyncTick` set
 * `catalogFailed` and `offersFailed`, and nothing read them: the worker endpoint
 * answered `{ ok: true, ...summary }` whatever had happened. So the two states
 * an operator most needs to tell apart — "not due" and "the catalogue Branch
 * Stock searches has not refreshed" — arrived as the same line, with the same
 * verdict on top.
 *
 * ---------------------------------------------------------------------------
 * What is fixed, and what is asserted here
 * ---------------------------------------------------------------------------
 *   1. `catalogChecked` / `offersChecked` distinguish "did not run" from "ran".
 *   2. `tickHadFailures` is the endpoint's `ok`, so failed work cannot be
 *      reported as a successful tick.
 *   3. A failed refresh still leaves the previous data serving, and records its
 *      own reason where the Control Center reads it. That is the property the
 *      honesty fix must not have traded away, so it is asserted alongside.
 *
 * The subsystems are mocked at their module boundary rather than driven through
 * the CRM: what is under test is the tick's *bookkeeping*, and the sweep and
 * refresh have their own suites.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shams-crm/sync.server", () => ({
  isSyncConfigured: vi.fn(() => true),
  getSyncStatus: vi.fn(),
  triggerSync: vi.fn(),
}));

vi.mock("@/lib/shams-crm/sync-settings.server", () => ({
  readSyncSettings: vi.fn(),
  readScheduleSlots: vi.fn(),
  advanceSlot: vi.fn(async () => {}),
}));

vi.mock("@/lib/shams-crm/catalog-sync.server", () => ({
  isCatalogRefreshDue: vi.fn(),
  refreshProductCatalog: vi.fn(),
}));

vi.mock("@/lib/shams-crm/offer-sync.server", () => ({
  isOfferSweepDue: vi.fn(),
  sweepOffers: vi.fn(),
}));

import {
  runShamsSyncTick,
  tickHadFailures,
  type ShamsSyncTickSummary,
} from "@/lib/shams-crm/sync-scheduler.server";
import { isCatalogRefreshDue, refreshProductCatalog } from "@/lib/shams-crm/catalog-sync.server";
import { isOfferSweepDue, sweepOffers } from "@/lib/shams-crm/offer-sync.server";
import { readScheduleSlots, readSyncSettings } from "@/lib/shams-crm/sync-settings.server";

const NOW = new Date("2026-09-07T12:00:30Z");

/** A Supabase stand-in that answers every read empty and swallows every write. */
function makeDb() {
  function chain() {
    const api: Record<string, unknown> = {
      insert: () => api,
      update: () => api,
      delete: () => api,
      select: () => api,
      single: () => api,
      maybeSingle: () => api,
      eq: () => api,
      in: () => api,
      lt: () => api,
      order: () => api,
      limit: () => api,
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(res, rej),
    };
    return api;
  }
  return { from: () => chain() } as never;
}

function catalogResult(over: Record<string, unknown> = {}) {
  return { outcome: "refreshed", rowCount: 8484, changed: 12, removed: 0, error: null, ...over };
}

function sweepResult(over: Record<string, unknown> = {}) {
  return {
    outcome: "swept",
    itemsProcessed: 150,
    itemsFailed: 0,
    rowsInserted: 4,
    rowsUpdated: 1,
    rowsDeleted: 0,
    rowsChanged: 5,
    offerRows: 900,
    productRows: 3000,
    itemsWithOffers: 40,
    sweepComplete: false,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  // No schedule slots and automation off: the trigger half of the tick is not
  // what this file is about, and leaving it inert keeps every assertion below
  // attributable to the catalogue and the offer sweep.
  vi.mocked(readSyncSettings).mockResolvedValue({
    automationEnabled: false,
    updatedAt: null,
    updatedBy: null,
  });
  vi.mocked(readScheduleSlots).mockResolvedValue([]);

  vi.mocked(isCatalogRefreshDue).mockResolvedValue(false);
  vi.mocked(isOfferSweepDue).mockResolvedValue(false);
  vi.mocked(refreshProductCatalog).mockResolvedValue(catalogResult() as never);
  vi.mocked(sweepOffers).mockResolvedValue(sweepResult() as never);
});

/* -------------------------------------------------------------------------- */
/* Idle is not failure, and failure is not idle                                */
/* -------------------------------------------------------------------------- */

describe("a tick says whether it looked", () => {
  it("reports nothing checked when neither subsystem is due", async () => {
    const summary = await runShamsSyncTick(makeDb(), NOW);

    expect(refreshProductCatalog).not.toHaveBeenCalled();
    expect(sweepOffers).not.toHaveBeenCalled();
    expect(summary.catalogChecked).toBe(false);
    expect(summary.offersChecked).toBe(false);
    // The exact four values the report quoted. On their own they say nothing;
    // the `checked` flags beside them are what make them readable.
    expect(summary.catalogRefreshed).toBe(false);
    expect(summary.catalogRows).toBe(0);
    expect(summary.offerSweepComplete).toBe(false);
    expect(summary.offerRowsChanged).toBe(0);
    expect(tickHadFailures(summary)).toBe(false);
  });

  it("reports both checked when both ran, and neither failed", async () => {
    vi.mocked(isCatalogRefreshDue).mockResolvedValue(true);
    vi.mocked(isOfferSweepDue).mockResolvedValue(true);

    const summary = await runShamsSyncTick(makeDb(), NOW);

    expect(summary.catalogChecked).toBe(true);
    expect(summary.catalogRefreshed).toBe(true);
    expect(summary.catalogRows).toBe(8484);
    expect(summary.offersChecked).toBe(true);
    expect(summary.offersSwept).toBe(true);
    expect(summary.offerRowsChanged).toBe(5);
    expect(tickHadFailures(summary)).toBe(false);
  });

  /**
   * The line the report actually saw, produced by a *failure*.
   *
   * `catalogRefreshed=false, catalogRows=0` — identical to the idle tick above,
   * and the only thing separating them is the pair of flags this test exists
   * for. Before them, an operator had nothing to distinguish the two by.
   */
  it("tells a failed catalogue refresh apart from an idle pass", async () => {
    vi.mocked(isCatalogRefreshDue).mockResolvedValue(true);
    vi.mocked(refreshProductCatalog).mockResolvedValue(
      catalogResult({
        outcome: "failed",
        rowCount: 0,
        changed: 0,
        error: "The product catalogue could not be written.",
      }) as never,
    );

    const summary = await runShamsSyncTick(makeDb(), NOW);

    expect(summary.catalogChecked).toBe(true);
    expect(summary.catalogFailed).toBe(true);
    expect(summary.catalogRefreshed).toBe(false);
    expect(tickHadFailures(summary)).toBe(true);
  });

  it("tells a failed offer sweep apart from an idle pass", async () => {
    vi.mocked(isOfferSweepDue).mockResolvedValue(true);
    vi.mocked(sweepOffers).mockResolvedValue(
      sweepResult({
        outcome: "failed",
        itemsProcessed: 0,
        rowsChanged: 0,
        error: "The refreshed Shams offers could not be promoted.",
      }) as never,
    );

    const summary = await runShamsSyncTick(makeDb(), NOW);

    expect(summary.offersChecked).toBe(true);
    expect(summary.offersFailed).toBe(true);
    expect(summary.offerRowsChanged).toBe(0);
    expect(tickHadFailures(summary)).toBe(true);
  });

  /**
   * A refresh that throws — a permission error on the way to the database, say —
   * rather than returning a verdict.
   *
   * Still contained: the tick returns, having triggered and reconciled whatever
   * it was going to. But it no longer returns quietly.
   */
  it("counts a thrown refresh as checked and failed, and still completes the tick", async () => {
    vi.mocked(isCatalogRefreshDue).mockRejectedValue(
      Object.assign(new Error("permission denied for table shams_catalog_state"), {
        name: "PostgrestError",
      }),
    );
    vi.mocked(isOfferSweepDue).mockResolvedValue(true);

    const summary = await runShamsSyncTick(makeDb(), NOW);

    expect(summary.catalogChecked).toBe(true);
    expect(summary.catalogFailed).toBe(true);
    // The offer sweep is not stopped by the catalogue's failure. Each half is
    // independently useful, and losing both because one broke would be a wider
    // outage than the fault deserves.
    expect(sweepOffers).toHaveBeenCalledTimes(1);
    expect(summary.offersSwept).toBe(true);
    expect(tickHadFailures(summary)).toBe(true);
  });

  it("does not treat a not-configured deployment as a failure", async () => {
    // No CRM credentials is a deployment choice, not an incident. The previous
    // rows keep serving and there is nothing for anyone to act on.
    vi.mocked(isCatalogRefreshDue).mockResolvedValue(true);
    vi.mocked(isOfferSweepDue).mockResolvedValue(true);
    vi.mocked(refreshProductCatalog).mockResolvedValue(
      catalogResult({ outcome: "not_configured", rowCount: 8484, changed: 0 }) as never,
    );
    vi.mocked(sweepOffers).mockResolvedValue(
      sweepResult({ outcome: "not_configured", itemsProcessed: 0, rowsChanged: 0 }) as never,
    );

    const summary = await runShamsSyncTick(makeDb(), NOW);

    expect(summary.catalogChecked).toBe(true);
    expect(summary.catalogFailed).toBe(false);
    expect(summary.offersFailed).toBe(false);
    expect(tickHadFailures(summary)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* What the endpoint reports                                                   */
/* -------------------------------------------------------------------------- */

describe("tickHadFailures is the endpoint's verdict", () => {
  const clean: ShamsSyncTickSummary = {
    slotsDue: 0,
    slotsMissed: 0,
    triggered: 0,
    skipped: 0,
    failed: 0,
    indeterminate: 0,
    reaped: 0,
    reconciled: 0,
    notConfigured: false,
    automationEnabled: true,
    catalogChecked: true,
    catalogRefreshed: true,
    catalogFailed: false,
    catalogRows: 8484,
    offersChecked: true,
    offersSwept: true,
    offersFailed: false,
    offerSweepComplete: false,
    offerRowsChanged: 5,
  };

  it("passes a tick where everything that ran worked", () => {
    expect(tickHadFailures(clean)).toBe(false);
  });

  it("fails on either subsystem", () => {
    expect(tickHadFailures({ ...clean, catalogFailed: true })).toBe(true);
    expect(tickHadFailures({ ...clean, offersFailed: true })).toBe(true);
  });

  it("fails on a refused trigger and on an unresolved one", () => {
    expect(tickHadFailures({ ...clean, failed: 1 })).toBe(true);
    // `indeterminate` needs a person: the request went out and nobody knows what
    // it did. A green scheduler over the top of one is what stops them looking.
    expect(tickHadFailures({ ...clean, indeterminate: 1 })).toBe(true);
  });

  it("does not fail on a slot recorded as missed", () => {
    // The tick that records a miss did its job. The failure it describes
    // happened earlier, and the row carries its own reason.
    expect(tickHadFailures({ ...clean, slotsMissed: 1, skipped: 2 })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The endpoint is wired to it                                                 */
/* -------------------------------------------------------------------------- */

describe("the worker endpoint reports the work, not the request", () => {
  /**
   * The one thing a unit test cannot reach: the route handler needs a running
   * TanStack Start server and a service-role client. What can be pinned is that
   * `ok` is derived rather than asserted — the literal `true` is what the bug
   * was — and that the status code is deliberately left alone.
   */
  it("derives ok from the summary and keeps a 2xx", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const route = readFileSync(
      fileURLToPath(new URL("../../../routes/api/shams-sync-run.ts", import.meta.url)),
      "utf8",
    );

    /*
     * The tick branch only.
     *
     * `reconcile` keeps `ok: true`, and correctly: it triggers nothing and
     * cannot fail work — a run it closes as `failed` failed at the CRM, which is
     * a fact it recorded rather than a malfunction of this endpoint.
     */
    const tickBranch = route.slice(
      route.indexOf('if (task === "tick")'),
      route.indexOf("const { runShamsSyncReconcile }"),
    );
    expect(tickBranch).toContain("const ok = !tickHadFailures(summary);");
    expect(tickBranch).toContain("return json({ ok, task, ...summary });");
    // The literal that made every tick look successful.
    expect(tickBranch).not.toContain("json({ ok: true, task, ...summary })");
    /*
     * The status code is deliberately left alone.
     *
     * A non-2xx would make the next `shams_sync_tick()` write "the scheduler was
     * refused by the application (HTTP n)" — a false sentence about a poke that
     * arrived and ran, and one that would mask the credential drift that message
     * exists to catch. So the tick branch hands `json` one argument and never a
     * status.
     */
    expect(tickBranch).not.toMatch(/json\([^;]*,\s*\d{3}\s*\)/);
  });
});
