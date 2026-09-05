/**
 * Refreshing the local product catalogue — and, mostly, declining to.
 *
 * The assertions here are overwhelmingly negative, for the same reason they are
 * in `sync-tick.test.ts`: this job runs unattended, and the way it fails badly
 * is not by throwing but by quietly replacing 8,484 good products with fewer, or
 * with none. Product search reads what this writes, so a bad refresh is an
 * outage for every agent on the floor, during calls, with no error anywhere.
 *
 * So each test names a way the refresh can go wrong and asserts that the
 * catalogue was **not touched**. `replaceCatalog` is the only call that can
 * change what agents search, and a test that does not expect it asserts it was
 * never made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShamsProduct } from "@/lib/shams/types";

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

const isCrmConfigured = vi.fn(() => true);
const crmFetch = vi.fn<(path: string, opts?: unknown) => Promise<unknown>>();
const fetchCatalogNow = vi.fn();

const replaceCatalog = vi.fn<(products: unknown, options?: unknown) => Promise<unknown>>();
const recordCatalogAttempt =
  vi.fn<(patch: { outcome: string; nextRefreshDueAt: Date }) => Promise<void>>();
const beginCatalogAttempt = vi.fn<(at: Date, due: Date) => Promise<void>>();
const readCatalogState = vi.fn();
const readCatalogHealth = vi.fn();

/** The CRM's own error type, which `summarize` reduces without leaking a body. */
class ShamsCrmError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

vi.mock("@/lib/shams-crm/client.server", () => ({
  isCrmConfigured: () => isCrmConfigured(),
  crmFetch: (path: string, opts?: unknown) => crmFetch(path, opts),
  ShamsCrmError,
}));

vi.mock("@/lib/shams-crm/catalog.server", () => ({
  fetchCatalogNow: () => fetchCatalogNow(),
}));

vi.mock("@/lib/shams/catalog-store.server", async () => {
  // The error class is real: `summarize` does an `instanceof` against it, and a
  // stand-in would silently take the "unexpected failure" branch for every
  // catalogue error this file raises.
  const actual = await vi.importActual<typeof import("@/lib/shams/catalog-store.server")>(
    "@/lib/shams/catalog-store.server",
  );
  return {
    ...actual,
    replaceCatalog: (products: unknown, options?: unknown) => replaceCatalog(products, options),
    recordCatalogAttempt: (patch: { outcome: string; nextRefreshDueAt: Date }) =>
      recordCatalogAttempt(patch),
    beginCatalogAttempt: (at: Date, due: Date) => beginCatalogAttempt(at, due),
    readCatalogState: () => readCatalogState(),
    readCatalogHealth: () => readCatalogHealth(),
  };
});

const { refreshProductCatalog, isCatalogRefreshDue } =
  await import("@/lib/shams-crm/catalog-sync.server");
const { ShamsCatalogError } = await import("@/lib/shams/catalog-store.server");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const NOW = new Date("2026-09-05T09:00:00Z");
const MARKER = "2026-09-05T02:14:00.000Z";

/** A catalogue the size production actually holds. */
const CATALOG: ShamsProduct[] = Array.from({ length: 8484 }, (_, i) => ({
  itemCode: String(10_400_000 + i),
  itemName: `PRODUCT ${i}`,
  retailPrice: i,
}));

/** `GET /stock/sync/status`, in the shape `normalizeSyncStatus` reads. */
function statusBody(marker: string | null) {
  return {
    is_running: false,
    latest_run: marker
      ? { run_id: "run-1", status: "success", completed_at: marker, started_at: marker }
      : null,
    last_success_at_utc: marker,
  };
}

/** State for a healthy catalogue refreshed an hour ago against `MARKER`. */
function healthyState(over: Record<string, unknown> = {}) {
  return {
    row_count: 8484,
    source_marker: MARKER,
    last_attempt_at: "2026-09-05T08:00:00Z",
    last_success_at: "2026-09-05T08:00:00Z",
    last_outcome: "success",
    last_error: null,
    next_refresh_due_at: "2026-09-05T09:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isCrmConfigured.mockReturnValue(true);
  recordCatalogAttempt.mockResolvedValue(undefined);
  beginCatalogAttempt.mockResolvedValue(undefined);
  readCatalogState.mockResolvedValue(healthyState());
  readCatalogHealth.mockResolvedValue({ rowCount: 8484, usable: true });
  crmFetch.mockResolvedValue(statusBody(MARKER));
  fetchCatalogNow.mockResolvedValue(CATALOG);
  replaceCatalog.mockResolvedValue({ staged: 8484, changed: 12, removed: 0, total: 8484 });
});

/* -------------------------------------------------------------------------- */
/* Deciding not to download                                                    */
/* -------------------------------------------------------------------------- */

describe("the marker decides, not a clock", () => {
  it("downloads nothing while the stock-sync marker has not moved", async () => {
    const result = await refreshProductCatalog({ now: NOW });

    expect(result.outcome).toBe("unchanged");
    expect(fetchCatalogNow).not.toHaveBeenCalled();
    expect(replaceCatalog).not.toHaveBeenCalled();
  });

  it("downloads when the marker has moved", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-05T08:40:00.000Z"));

    const result = await refreshProductCatalog({ now: NOW });

    expect(result.outcome).toBe("refreshed");
    expect(fetchCatalogNow).toHaveBeenCalledTimes(1);
    expect(replaceCatalog).toHaveBeenCalledTimes(1);
    expect(result.rowCount).toBe(8484);
    expect(result.changed).toBe(12);
  });

  it("records the marker it fetched against, so the next check can compare", async () => {
    const moved = "2026-09-05T08:40:00.000Z";
    crmFetch.mockResolvedValue(statusBody(moved));

    await refreshProductCatalog({ now: NOW });

    expect(replaceCatalog).toHaveBeenCalledWith(
      CATALOG,
      expect.objectContaining({ sourceMarker: moved }),
    );
  });

  it("downloads anyway when the catalogue is empty, whatever the marker says", async () => {
    // The bootstrap case, and the one where waiting for a marker would mean
    // waiting forever with search unusable.
    readCatalogState.mockResolvedValue(healthyState({ row_count: 0, last_success_at: null }));

    await refreshProductCatalog({ now: NOW });

    expect(fetchCatalogNow).toHaveBeenCalledTimes(1);
  });

  it("downloads anyway once the catalogue is a day old", async () => {
    // The safety net under the marker: the captured deployment reports its own
    // sync interval as "Manual", so a marker that never moves is a real state.
    readCatalogState.mockResolvedValue(healthyState({ last_success_at: "2026-09-03T09:00:00Z" }));

    await refreshProductCatalog({ now: NOW });

    expect(fetchCatalogNow).toHaveBeenCalledTimes(1);
  });

  it("downloads on an explicit force, marker or no marker", async () => {
    const result = await refreshProductCatalog({ now: NOW, force: true });

    expect(result.outcome).toBe("refreshed");
    expect(fetchCatalogNow).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure never costs the catalogue                                           */
/* -------------------------------------------------------------------------- */

describe("a failed refresh leaves the last known good catalogue serving", () => {
  it("does not download when the status read fails", async () => {
    crmFetch.mockRejectedValue(new ShamsCrmError("unavailable", "Unable to reach Shams CRM."));

    const result = await refreshProductCatalog({ now: NOW });

    expect(result.outcome).toBe("failed");
    // A CRM that cannot serve a small status document will not serve 700 KB,
    // and trying anyway would turn every wobble into a full download.
    expect(fetchCatalogNow).not.toHaveBeenCalled();
    expect(replaceCatalog).not.toHaveBeenCalled();
    expect(result.rowCount).toBe(8484);
  });

  it("keeps the previous rows when the download fails", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-05T08:40:00.000Z"));
    fetchCatalogNow.mockRejectedValue(new ShamsCrmError("timeout", "Shams CRM timed out.", null));

    const result = await refreshProductCatalog({ now: NOW });

    expect(result.outcome).toBe("failed");
    expect(replaceCatalog).not.toHaveBeenCalled();
    expect(result.rowCount).toBe(8484);
  });

  it("keeps the previous rows when the download comes up short", async () => {
    /*
     * The failure this whole design is shaped around. A truncated response looks
     * exactly like a catalogue that shrank, and promoting it would break search
     * far more thoroughly than a stale price ever could.
     */
    crmFetch.mockResolvedValue(statusBody("2026-09-05T08:40:00.000Z"));
    fetchCatalogNow.mockResolvedValue(CATALOG.slice(0, 40));
    replaceCatalog.mockRejectedValue(
      new ShamsCatalogError("catalog_empty", "The Shams CRM catalogue returned 40 products."),
    );

    const result = await refreshProductCatalog({ now: NOW });

    expect(result.outcome).toBe("failed");
    expect(result.rowCount).toBe(8484);
    expect(recordCatalogAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("never throws, whatever the CRM does", async () => {
    // It runs inside the scheduler tick, where an exception would take the
    // reconciliation pass down with it, and behind a button, where a stack
    // trace is not an answer.
    crmFetch.mockRejectedValue(new Error("something entirely unexpected"));
    readCatalogState.mockResolvedValue(healthyState({ row_count: 0, last_success_at: null }));
    fetchCatalogNow.mockRejectedValue(new Error("and again"));

    await expect(refreshProductCatalog({ now: NOW })).resolves.toMatchObject({
      outcome: "failed",
    });
  });

  it("puts no upstream detail into the error an administrator reads", async () => {
    crmFetch.mockRejectedValue(
      new Error('500 from https://shams-crm.cloud/stock/sync/status: {"token":"secret"}'),
    );
    readCatalogState.mockResolvedValue(healthyState({ row_count: 0, last_success_at: null }));
    fetchCatalogNow.mockRejectedValue(
      new Error('500 from https://shams-crm.cloud/products/names: {"token":"secret"}'),
    );

    const result = await refreshProductCatalog({ now: NOW });

    expect(result.error).toBe(
      "An unexpected error occurred while refreshing the product catalogue.",
    );
    expect(result.error).not.toMatch(/shams-crm\.cloud|secret|500/);
  });

  it("schedules the next attempt rather than leaving itself due", async () => {
    /*
     * Without this the tick — which runs every minute — would retry a failing
     * refresh 1,440 times a day against a CRM that is already unwell.
     */
    crmFetch.mockRejectedValue(new ShamsCrmError("unavailable", "Unable to reach Shams CRM."));

    await refreshProductCatalog({ now: NOW });

    const patch = recordCatalogAttempt.mock.lastCall![0];
    expect(patch.outcome).toBe("failed");
    expect(patch.nextRefreshDueAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("claims the attempt before touching the network", async () => {
    // A worker killed mid-refresh must not leave the catalogue still due, or the
    // next tick walks straight back into whatever killed it.
    await refreshProductCatalog({ now: NOW });

    expect(beginCatalogAttempt).toHaveBeenCalled();
    const order = beginCatalogAttempt.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(crmFetch.mock.invocationCallOrder[0]);
  });
});

/* -------------------------------------------------------------------------- */
/* Not configured                                                              */
/* -------------------------------------------------------------------------- */

describe("a deployment with no Shams CRM credentials", () => {
  it("is a recorded state, not a failure, and touches nothing", async () => {
    isCrmConfigured.mockReturnValue(false);

    const result = await refreshProductCatalog({ now: NOW });

    expect(result.outcome).toBe("not_configured");
    expect(result.error).toBeNull();
    expect(crmFetch).not.toHaveBeenCalled();
    expect(fetchCatalogNow).not.toHaveBeenCalled();
    expect(replaceCatalog).not.toHaveBeenCalled();
  });

  it("leaves the seeded catalogue in place, so search still works", async () => {
    isCrmConfigured.mockReturnValue(false);
    readCatalogHealth.mockResolvedValue({ rowCount: 8484, usable: true });

    const result = await refreshProductCatalog({ now: NOW });

    expect(result.rowCount).toBe(8484);
  });
});

/* -------------------------------------------------------------------------- */
/* Due-ness                                                                    */
/* -------------------------------------------------------------------------- */

describe("isCatalogRefreshDue", () => {
  const db = (row: unknown, error: unknown = null) => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }),
    }),
  });

  it("is due when the state row has never been scheduled", async () => {
    expect(await isCatalogRefreshDue(db({ next_refresh_due_at: null }), NOW)).toBe(true);
  });

  it("is due when the scheduled time has passed", async () => {
    expect(
      await isCatalogRefreshDue(db({ next_refresh_due_at: "2026-09-05T08:59:00Z" }), NOW),
    ).toBe(true);
  });

  it("is not due before it", async () => {
    expect(
      await isCatalogRefreshDue(db({ next_refresh_due_at: "2026-09-05T09:01:00Z" }), NOW),
    ).toBe(false);
  });

  it("errs towards running when the state cannot be read", async () => {
    // An extra check is harmless; a silently skipped one is not.
    expect(await isCatalogRefreshDue(db(null, { code: "42P01" }), NOW)).toBe(true);
  });
});
