/**
 * Sweeping Shams offers into the local dataset — and, mostly, declining to.
 *
 * The assertions here are overwhelmingly negative, for the same reason they are
 * in `catalog-refresh.test.ts`: this job runs unattended, and the way it fails
 * badly is not by throwing but by quietly replacing good promotional prices with
 * fewer, or with none. Branch Stock reads what this writes, so a bad sweep is an
 * agent quoting the wrong price, on a call, with no error anywhere.
 *
 * Offers add one failure mode the catalogue does not have. A catalogue refresh
 * is complete by construction — one request answers with every product — so its
 * promotion may delete anything the response did not mention. A sweep covers
 * 150 of 8,484 products, so a promotion that deleted what it did not cover would
 * erase the other 8,334 on every single run. Several tests below exist only to
 * pin that the cursor and the slice's own item codes are what bound the writes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShamsCrmOffer, ShamsOfferScope } from "@/lib/shams-crm/types";

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

const isCrmConfigured = vi.fn(() => true);
const crmFetch = vi.fn<(path: string, opts?: unknown) => Promise<unknown>>();
const fetchOfferReadNow =
  vi.fn<(code: string) => Promise<{ offers: ShamsCrmOffer[]; scope: ShamsOfferScope }>>();

const promoteOfferSlice = vi.fn<(items: unknown, options: any) => Promise<unknown>>();
const recordOfferAttempt = vi.fn<(patch: Record<string, unknown>) => Promise<void>>();
const beginOfferAttempt = vi.fn<(at: Date, due: Date, opts?: unknown) => Promise<void>>();
const readOfferSyncState = vi.fn();
const nextSweepItemCodes = vi.fn<(after: string | null, limit: number) => Promise<string[]>>();

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

vi.mock("@/lib/shams-crm/offers.server", async () => {
  // `classifyOfferScope` is real: the sweep hands its verdict to
  // `summariseProductOffer`, and a stand-in would let the two drift apart in a
  // suite that is partly about them agreeing.
  const actual = await vi.importActual<typeof import("@/lib/shams-crm/offers.server")>(
    "@/lib/shams-crm/offers.server",
  );
  return { ...actual, fetchOfferReadNow: (code: string) => fetchOfferReadNow(code) };
});

vi.mock("@/lib/shams/offer-store.server", async () => {
  // The error class is real: `summarize` does an `instanceof` against it, and a
  // stand-in would silently take the "unexpected failure" branch.
  const actual = await vi.importActual<typeof import("@/lib/shams/offer-store.server")>(
    "@/lib/shams/offer-store.server",
  );
  return {
    ...actual,
    promoteOfferSlice: (items: unknown, options: unknown) => promoteOfferSlice(items, options),
    recordOfferAttempt: (patch: Record<string, unknown>) => recordOfferAttempt(patch),
    beginOfferAttempt: (at: Date, due: Date, opts?: unknown) => beginOfferAttempt(at, due, opts),
    readOfferSyncState: () => readOfferSyncState(),
    nextSweepItemCodes: (after: string | null, limit: number) => nextSweepItemCodes(after, limit),
  };
});

const { sweepOffers, SWEEP_SLICE_ITEMS } = await import("@/lib/shams-crm/offer-sync.server");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const NOW = new Date("2026-09-06T09:00:00.000Z");

/** A synced, idle dataset whose last full sweep was an hour ago. */
function settledState(overrides: Record<string, unknown> = {}) {
  return {
    offer_row_count: 412,
    product_row_count: 8484,
    items_with_offers: 74,
    source_marker: "2026-09-06T05:00:00Z",
    cursor_item_code: null,
    sweep_started_at: null,
    sweep_completed_at: "2026-09-06T08:00:00.000Z",
    sweep_items_done: 0,
    last_attempt_at: "2026-09-06T08:00:00.000Z",
    last_success_at: "2026-09-06T08:00:00.000Z",
    last_full_sweep_at: "2026-09-06T08:00:00.000Z",
    last_outcome: "success",
    last_error: null,
    next_refresh_due_at: null,
    ...overrides,
  };
}

const statusBody = (marker: string) => ({
  latest_run: { status: "success", completed_at: marker },
  last_success_at_utc: marker,
});

const anOffer = (branchCode: string): ShamsCrmOffer => ({
  itemCode: "1",
  branchCode,
  price: 60.62,
  offerPercent: 20,
  offerDisplay: "20.00%",
  afterOfferPrice: 48.5,
});

/** What `fetchOfferReadNow` returns for a product on offer everywhere. */
function onOfferEverywhere(code: string) {
  const offers = [anOffer("P0221"), anOffer("P0222")].map((o) => ({ ...o, itemCode: code }));
  return {
    offers,
    scope: {
      itemCode: code,
      kind: "all" as const,
      branchesAvailable: 2,
      branchesWithOffer: 2,
      offerDisplay: "20.00%",
    },
  };
}

function noOffer(code: string) {
  return {
    offers: [] as ShamsCrmOffer[],
    scope: {
      itemCode: code,
      kind: "none" as const,
      branchesAvailable: 40,
      branchesWithOffer: 0,
      offerDisplay: null,
    },
  };
}

const promotion = (overrides: Record<string, number | boolean> = {}) => ({
  items: 2,
  inserted: 0,
  updated: 0,
  deleted: 0,
  summariesChanged: 0,
  changed: 0,
  offerRows: 412,
  productRows: 8484,
  itemsWithOffers: 74,
  sweepComplete: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  isCrmConfigured.mockReturnValue(true);
  readOfferSyncState.mockResolvedValue(settledState());
  nextSweepItemCodes.mockResolvedValue([]);
  promoteOfferSlice.mockResolvedValue(promotion());
  recordOfferAttempt.mockResolvedValue(undefined);
  beginOfferAttempt.mockResolvedValue(undefined);
  fetchOfferReadNow.mockImplementation(async (code: string) => noOffer(code));
  crmFetch.mockResolvedValue(statusBody("2026-09-06T05:00:00Z"));
});

/* -------------------------------------------------------------------------- */
/* Nothing is swept without a reason                                           */
/* -------------------------------------------------------------------------- */

describe("deciding whether to sweep at all", () => {
  it("does nothing when the promotions marker has not moved", () => {
    return sweepOffers({ now: NOW }).then((result) => {
      expect(result.outcome).toBe("unchanged");
      expect(fetchOfferReadNow).not.toHaveBeenCalled();
      expect(promoteOfferSlice).not.toHaveBeenCalled();
    });
  });

  it("starts a sweep when the marker has moved", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    nextSweepItemCodes.mockResolvedValue(["1", "2"]);

    const result = await sweepOffers({ now: NOW });

    expect(result.outcome).toBe("swept");
    expect(fetchOfferReadNow).toHaveBeenCalledTimes(2);
    expect(promoteOfferSlice).toHaveBeenCalledOnce();
  });

  it("starts one when the dataset has never been swept", async () => {
    readOfferSyncState.mockResolvedValue(
      settledState({ product_row_count: 0, last_full_sweep_at: null, last_success_at: null }),
    );
    nextSweepItemCodes.mockResolvedValue(["1"]);

    expect((await sweepOffers({ now: NOW })).outcome).toBe("swept");
  });

  it("reads the promotions status, never the stock one", async () => {
    await sweepOffers({ now: NOW });
    expect(crmFetch).toHaveBeenCalledWith("/promotions/sync/status", expect.anything());
  });

  /**
   * `POST /promotions/sync` starts a ~24-minute job on Shams' own
   * infrastructure (`api-discovery.md` §11.3). Nothing on any page may fire it,
   * and a sweep that "helpfully" triggered one before reading would be the
   * worst possible reading of "refresh the offers".
   */
  it("never triggers a synchronisation run on Shams", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    nextSweepItemCodes.mockResolvedValue(["1"]);
    await sweepOffers({ now: NOW, force: true });

    for (const [path] of crmFetch.mock.calls) {
      expect(path).not.toBe("/promotions/sync");
      expect(path).not.toBe("/stock/sync");
    }
  });

  it("skips the marker read entirely while a sweep is in progress", async () => {
    readOfferSyncState.mockResolvedValue(settledState({ cursor_item_code: "4000" }));
    nextSweepItemCodes.mockResolvedValue(["4001"]);

    await sweepOffers({ now: NOW });

    // Re-reading it between slices would let a marker that moved mid-sweep
    // restart one that is nearly done, and would spend a request every two
    // minutes for an answer that cannot change the plan.
    expect(crmFetch).not.toHaveBeenCalled();
    expect(nextSweepItemCodes).toHaveBeenCalledWith("4000", SWEEP_SLICE_ITEMS);
  });

  it("resumes from the cursor rather than restarting", async () => {
    readOfferSyncState.mockResolvedValue(settledState({ cursor_item_code: "5500" }));
    nextSweepItemCodes.mockResolvedValue(["5501"]);
    await sweepOffers({ now: NOW });
    expect(nextSweepItemCodes).toHaveBeenCalledWith("5500", SWEEP_SLICE_ITEMS);
  });

  it("restarts from the beginning when forced", async () => {
    readOfferSyncState.mockResolvedValue(settledState({ cursor_item_code: "5500" }));
    nextSweepItemCodes.mockResolvedValue(["1"]);
    await sweepOffers({ now: NOW, force: true });
    expect(nextSweepItemCodes).toHaveBeenCalledWith(null, SWEEP_SLICE_ITEMS);
  });
});

/* -------------------------------------------------------------------------- */
/* A failure never costs the previous data                                     */
/* -------------------------------------------------------------------------- */

describe("last known good survives everything", () => {
  it("touches nothing when the CRM is not configured", async () => {
    isCrmConfigured.mockReturnValue(false);

    const result = await sweepOffers({ now: NOW });

    expect(result.outcome).toBe("not_configured");
    expect(promoteOfferSlice).not.toHaveBeenCalled();
    expect(fetchOfferReadNow).not.toHaveBeenCalled();
    expect(recordOfferAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "not_configured" }),
    );
  });

  it("touches nothing when the status read fails", async () => {
    crmFetch.mockRejectedValue(new ShamsCrmError("unavailable", "Unable to reach Shams CRM."));

    const result = await sweepOffers({ now: NOW });

    expect(result.outcome).toBe("failed");
    expect(promoteOfferSlice).not.toHaveBeenCalled();
  });

  it("touches nothing when the whole slice fails", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    nextSweepItemCodes.mockResolvedValue(["1", "2", "3"]);
    fetchOfferReadNow.mockRejectedValue(new ShamsCrmError("timeout", "Too slow."));

    const result = await sweepOffers({ now: NOW });

    expect(result.outcome).toBe("failed");
    expect(result.itemsFailed).toBe(3);
    expect(promoteOfferSlice).not.toHaveBeenCalled();
  });

  /**
   * The cursor is the sweep's memory, and advancing it past products nobody
   * managed to read would leave a hole no later run revisits — 150 products
   * silently stuck on whatever they held before, with the dataset reporting a
   * complete pass.
   */
  it("does not advance the cursor when the whole slice fails", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    nextSweepItemCodes.mockResolvedValue(["1", "2"]);
    fetchOfferReadNow.mockRejectedValue(new ShamsCrmError("timeout", "Too slow."));

    await sweepOffers({ now: NOW });

    expect(promoteOfferSlice).not.toHaveBeenCalled();
    expect(recordOfferAttempt).toHaveBeenCalledWith(
      expect.not.objectContaining({ resetCursor: true }),
    );
  });

  it("touches nothing when the promotion itself fails", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    nextSweepItemCodes.mockResolvedValue(["1"]);
    promoteOfferSlice.mockRejectedValue(new Error("promotion refused"));

    const result = await sweepOffers({ now: NOW });

    expect(result.outcome).toBe("failed");
    expect(recordOfferAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  /**
   * An empty catalogue is the offers equivalent of the catalogue refresh's row
   * floor: there is no slice to promote, so nothing is promoted. Promoting an
   * empty slice would advance the cursor over products nobody looked at.
   */
  it("promotes nothing when the catalogue has no items to sweep", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    readOfferSyncState.mockResolvedValue(
      settledState({ product_row_count: 0, last_full_sweep_at: null }),
    );
    nextSweepItemCodes.mockResolvedValue([]);

    const result = await sweepOffers({ now: NOW });

    expect(result.outcome).toBe("unchanged");
    expect(promoteOfferSlice).not.toHaveBeenCalled();
  });

  it("never lets an error message carry an upstream body", async () => {
    crmFetch.mockRejectedValue(
      new ShamsCrmError("http_error", "Shams CRM returned an unexpected status.", 503),
    );

    const result = await sweepOffers({ now: NOW });

    expect(result.error).toBe("Shams CRM returned an unexpected status. (http_error, HTTP 503)");
    expect(result.error).not.toMatch(/session|token|password|https?:/i);
  });

  it("reduces an unrecognised throw to one generic sentence", async () => {
    crmFetch.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.4:443"));
    const result = await sweepOffers({ now: NOW });
    expect(result.error).toBe("An unexpected error occurred while sweeping Shams offers.");
    expect(result.error).not.toMatch(/10\.0\.0\.4/);
  });
});

/* -------------------------------------------------------------------------- */
/* One item's failure is not the slice's                                       */
/* -------------------------------------------------------------------------- */

describe("a partial slice", () => {
  beforeEach(() => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
  });

  it("promotes the items that answered and omits the ones that did not", async () => {
    nextSweepItemCodes.mockResolvedValue(["1", "2", "3"]);
    fetchOfferReadNow.mockImplementation(async (code: string) => {
      if (code === "2") throw new ShamsCrmError("timeout", "Too slow.");
      return noOffer(code);
    });

    const result = await sweepOffers({ now: NOW });

    expect(result.outcome).toBe("swept");
    expect(result.itemsFailed).toBe(1);

    const [items] = promoteOfferSlice.mock.calls[0] as [{ summary: { itemCode: string } }[], any];
    expect(items.map((i) => i.summary.itemCode)).toEqual(["1", "3"]);
  });

  /**
   * An item the CRM refused is **omitted**, never staged as "no offer". Its
   * existing rows survive untouched and the next full pass revisits it — the
   * same rule `getOfferScopes` follows, and for the same reason: a CRM being
   * unreachable is not evidence about a promotion.
   */
  it("does not stage a failed item as having no offer", async () => {
    nextSweepItemCodes.mockResolvedValue(["1", "2"]);
    fetchOfferReadNow.mockImplementation(async (code: string) => {
      if (code === "2") throw new ShamsCrmError("unavailable", "No.");
      return onOfferEverywhere(code);
    });

    await sweepOffers({ now: NOW });

    const [items] = promoteOfferSlice.mock.calls[0] as [{ summary: { itemCode: string } }[], any];
    expect(items.some((i) => i.summary.itemCode === "2")).toBe(false);
  });

  /**
   * The cursor is the last code **asked about**, not the last that answered.
   * Parking it on a failure would stall the sweep on one bad product forever.
   */
  it("advances the cursor past an item that failed", async () => {
    nextSweepItemCodes.mockResolvedValue(["1", "2", "3"]);
    fetchOfferReadNow.mockImplementation(async (code: string) => {
      if (code === "3") throw new ShamsCrmError("timeout", "Too slow.");
      return noOffer(code);
    });

    await sweepOffers({ now: NOW });

    const [, options] = promoteOfferSlice.mock.calls[0] as [unknown, { cursor: string }];
    expect(options.cursor).toBe("3");
  });
});

/* -------------------------------------------------------------------------- */
/* What gets staged                                                            */
/* -------------------------------------------------------------------------- */

describe("what a slice hands the promotion", () => {
  beforeEach(() => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
  });

  it("records a checked item with no promotion, so 'none' is sayable", async () => {
    nextSweepItemCodes.mockResolvedValue(["1"]);
    fetchOfferReadNow.mockImplementation(async (code) => noOffer(code));

    await sweepOffers({ now: NOW });

    const [items] = promoteOfferSlice.mock.calls[0] as [
      { summary: { scope: string }; offers: unknown[] }[],
      any,
    ];
    // A verdict row with no branch rows. Without it the dataset could not tell
    // "asked, no promotion" from "not asked yet".
    expect(items).toHaveLength(1);
    expect(items[0].summary.scope).toBe("none");
    expect(items[0].offers).toHaveLength(0);
  });

  it("derives the product-level price pair through the pure summariser", async () => {
    nextSweepItemCodes.mockResolvedValue(["1"]);
    fetchOfferReadNow.mockImplementation(async (code) => onOfferEverywhere(code));

    await sweepOffers({ now: NOW });

    const [items] = promoteOfferSlice.mock.calls[0] as [
      { summary: { scope: string; unitPrice: number | null; offerPrice: number | null } }[],
      any,
    ];
    expect(items[0].summary.scope).toBe("all");
    expect(items[0].summary.unitPrice).toBe(60.62);
    expect(items[0].summary.offerPrice).toBe(48.5);
  });

  it("marks the sweep complete only on a short final slice", async () => {
    nextSweepItemCodes.mockResolvedValue(["1", "2"]);
    await sweepOffers({ now: NOW });
    let [, options] = promoteOfferSlice.mock.calls[0] as [unknown, { sweepComplete: boolean }];
    // Two of a possible 150 means the catalogue ran out.
    expect(options.sweepComplete).toBe(true);

    vi.clearAllMocks();
    readOfferSyncState.mockResolvedValue(settledState({ cursor_item_code: "100" }));
    promoteOfferSlice.mockResolvedValue(promotion());
    nextSweepItemCodes.mockResolvedValue(
      Array.from({ length: SWEEP_SLICE_ITEMS }, (_, i) => String(i)),
    );
    await sweepOffers({ now: NOW });
    [, options] = promoteOfferSlice.mock.calls[0] as [unknown, { sweepComplete: boolean }];
    expect(options.sweepComplete).toBe(false);
  });

  it("stamps the slice with the marker it was swept against", async () => {
    nextSweepItemCodes.mockResolvedValue(["1"]);
    await sweepOffers({ now: NOW });
    const [, options] = promoteOfferSlice.mock.calls[0] as [unknown, { sourceMarker: string }];
    // Normalized by `normalizeSyncStatus` on the way through, which is what the
    // state row stores and what the next run compares against.
    expect(options.sourceMarker).toBe("2026-09-06T08:30:00.000Z");
  });
});

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

describe("what the sweep reports", () => {
  beforeEach(() => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    nextSweepItemCodes.mockResolvedValue(["1", "2"]);
  });

  /**
   * The distinction an operator reads off the admin panel. A slice routinely
   * processes 150 products and changes nothing at all; reporting the first as
   * the second would suggest the dataset is being rewritten every two minutes.
   */
  it("reports rows changed separately from items processed", async () => {
    promoteOfferSlice.mockResolvedValue(
      promotion({ items: 150, inserted: 0, updated: 0, deleted: 0, changed: 0 }),
    );

    const result = await sweepOffers({ now: NOW });

    expect(result.itemsProcessed).toBe(150);
    expect(result.rowsChanged).toBe(0);
  });

  it("passes the promotion's own insert, update and delete counts through", async () => {
    promoteOfferSlice.mockResolvedValue(
      promotion({ items: 150, inserted: 3, updated: 5, deleted: 2, changed: 11 }),
    );

    const result = await sweepOffers({ now: NOW });

    expect(result.rowsInserted).toBe(3);
    expect(result.rowsUpdated).toBe(5);
    expect(result.rowsDeleted).toBe(2);
    // Eleven, not ten: a verdict whose coverage moved is a change even when no
    // per-branch price did.
    expect(result.rowsChanged).toBe(11);
  });
});

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

describe("when the next look happens", () => {
  it("claims the attempt before the network is touched", async () => {
    await sweepOffers({ now: NOW });
    expect(beginOfferAttempt).toHaveBeenCalled();
    // A worker killed mid-slice otherwise leaves the sweep still due, and the
    // next tick — a minute later — walks into whatever killed it.
    const order = beginOfferAttempt.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(crmFetch.mock.invocationCallOrder[0]);
  });

  it("backs off further after a failure than after a quiet check", async () => {
    crmFetch.mockRejectedValue(new ShamsCrmError("unavailable", "No."));
    await sweepOffers({ now: NOW });
    const failedDue = (recordOfferAttempt.mock.calls[0][0] as { nextRefreshDueAt: Date })
      .nextRefreshDueAt;

    vi.clearAllMocks();
    readOfferSyncState.mockResolvedValue(settledState());
    recordOfferAttempt.mockResolvedValue(undefined);
    beginOfferAttempt.mockResolvedValue(undefined);
    crmFetch.mockResolvedValue(statusBody("2026-09-06T05:00:00Z"));
    await sweepOffers({ now: NOW });
    const idleDue = (recordOfferAttempt.mock.calls[0][0] as { nextRefreshDueAt: Date })
      .nextRefreshDueAt;

    // A failure retries sooner than an idle check, and neither is the one-minute
    // tick: a CRM that is down must not be asked 1,440 times a day.
    expect(failedDue.getTime()).toBeGreaterThan(NOW.getTime() + 60_000);
    expect(failedDue.getTime()).toBeLessThan(idleDue.getTime());
  });

  it("schedules the next slice sooner than the idle check", async () => {
    crmFetch.mockResolvedValue(statusBody("2026-09-06T08:30:00Z"));
    nextSweepItemCodes.mockResolvedValue(["1"]);
    await sweepOffers({ now: NOW });

    const [, due] = beginOfferAttempt.mock.calls[0] as [Date, Date];
    // Two minutes, so a 57-slice pass finishes in about two hours rather than
    // over two days at the idle hour.
    expect(due.getTime() - NOW.getTime()).toBeLessThanOrEqual(5 * 60_000);
  });
});
