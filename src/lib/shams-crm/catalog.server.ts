/**
 * Shams CRM product catalog (server-only).
 *
 * `GET /products/names` returns the **whole** catalog as a bare JSON array —
 * ~8 500 rows of `{code, name, price}`, about 700 KB — with no pagination and no
 * parameters. That is the point of it: the MIS `product/search` this portal
 * already uses caps at 50 rows, so a broad query is truncated before the wanted
 * product is ever seen. A complete catalog held server-side is what makes true
 * wildcard and partial-item-code matching possible.
 *
 * **Server-side only.** The array never crosses to a browser; callers ask this
 * module for matches and send those. Nothing is written to Supabase.
 *
 * Kept apart from `client.server.ts` on purpose: that module knows about
 * sessions and this one knows about products, and a future search layer will
 * know about neither.
 */

import { crmFetch } from "./client.server";
import type { RawCrmProductRow, ShamsCrmProduct } from "./types";

const CATALOG_PATH = "/products/names";

/**
 * How long the catalog is served before a refetch.
 *
 * Six hours. Measured drift between the Desktop's shipped seed and the live
 * endpoint 20 days later was 488 of 8 484 prices and 11 names — roughly 0.3 % of
 * rows a day, with no code added or removed (`docs/shams/api-discovery.md`
 * §10.6). This is reference data for *finding* a product; the price an agent
 * acts on still comes from the MIS live reads, so a few hours of staleness here
 * costs nothing and a shorter TTL would just re-download 700 KB for no gain.
 *
 * The Desktop instead refreshes when a stock-sync marker changes. That is the
 * better design and is available later through `refreshCatalog`.
 */
const CATALOG_TTL_MS = 6 * 60 * 60_000;

/** The catalog read is the largest response this integration makes. */
const CATALOG_TIMEOUT_MS = 90_000;

interface CatalogState {
  products: ShamsCrmProduct[];
  expiresAt: number;
  fetchedAt: number;
}

let catalog: CatalogState | null = null;
/** In-flight fetch, so N concurrent callers cause one download. */
let inFlight: Promise<CatalogState> | null = null;
/**
 * Upstream fetches that actually succeeded.
 *
 * The one thing `getCatalog` cannot otherwise tell a caller: it returns the same
 * `ShamsCrmProduct[]` whether the rows are newly downloaded or the previous
 * catalog served after a failed refresh. Age does not separate them either — a
 * fallback keeps the old `fetchedAt`, but so does a cache hit moments after a
 * genuine fetch.
 *
 * Monotonic and never reset except by the test seam, so a caller compares it
 * across a call rather than reading it absolutely.
 */
let successfulFetches = 0;

/** Test seam; also lets a diagnostics surface force a cold read. */
export function _clearCatalogCache(): void {
  catalog = null;
  inFlight = null;
  successfulFetches = 0;
}

/**
 * Drop rows that cannot be searched.
 *
 * A row without a code or a name is not a product anyone can find or select, so
 * it is left out rather than carried as an empty string. Price is optional and
 * defaults to 0 — a missing price must not remove an otherwise findable product.
 */
function normalize(rows: RawCrmProductRow[]): ShamsCrmProduct[] {
  const out: ShamsCrmProduct[] = [];
  for (const row of rows) {
    const itemCode = typeof row?.code === "string" ? row.code.trim() : "";
    const itemName = typeof row?.name === "string" ? row.name.trim() : "";
    if (!itemCode || !itemName) continue;
    out.push({
      itemCode,
      itemName,
      retailPrice: typeof row?.price === "number" && Number.isFinite(row.price) ? row.price : 0,
    });
  }
  return out;
}

async function fetchCatalog(): Promise<CatalogState> {
  const body = await crmFetch<RawCrmProductRow[]>(CATALOG_PATH, {
    timeoutMs: CATALOG_TIMEOUT_MS,
  });
  if (!Array.isArray(body)) {
    // A bare array is the documented shape; anything else is not a catalog, and
    // replacing a good cache with it would be worse than failing.
    const { ShamsCrmError } = await import("./client.server");
    throw new ShamsCrmError("malformed", "Shams CRM returned an unreadable catalog.");
  }
  const products = normalize(body);
  const now = Date.now();
  successfulFetches++;
  return { products, expiresAt: now + CATALOG_TTL_MS, fetchedAt: now };
}

/**
 * The catalog, from cache when it is fresh.
 *
 * Single-flight: a cold cache under concurrent load downloads once, not once per
 * caller. **A failed refresh does not empty a good cache** — if a refetch throws
 * while a previous catalog is still held, that catalog is returned and the error
 * is swallowed. Stale reference data beats no reference data; only a cold cache
 * can fail this function.
 */
export async function getCatalog(): Promise<ShamsCrmProduct[]> {
  if (catalog && catalog.expiresAt > Date.now()) return catalog.products;
  if (inFlight) return (await inFlight).products;

  const previous = catalog;
  inFlight = fetchCatalog().then(
    (next) => {
      catalog = next;
      return next;
    },
    (err) => {
      if (previous) return previous;
      throw err;
    },
  );
  try {
    return (await inFlight).products;
  } finally {
    inFlight = null;
  }
}

/**
 * Download the catalogue now, with no cache and no fallback.
 *
 * What `getCatalog` deliberately cannot do. Its stale-fallback rule — return the
 * previous rows when a refresh throws — is right for a caller that wants
 * *something* to match against, and exactly wrong for the persistence refresh in
 * `catalog-sync.server.ts`, which must be able to tell "8,484 fresh rows" from
 * "the same 8,484 rows I already had". Writing the fallback back into Postgres
 * would be harmless; recording it as a successful refresh, and stamping it with
 * the new marker, would not be.
 *
 * The in-memory cache is still filled on success, so a deployment that also uses
 * `getCatalog` for something is not made to download twice.
 *
 * Throws `ShamsCrmError` on any failure. Nothing is swallowed here.
 */
export async function fetchCatalogNow(): Promise<ShamsCrmProduct[]> {
  const next = await fetchCatalog();
  catalog = next;
  return next.products;
}

/**
 * Force a refetch on the next `getCatalog`. For a future marker-driven refresh.
 *
 * Marks the cache **stale** rather than deleting it. Deleting it would throw
 * away the fallback that `getCatalog` relies on, so an explicit refresh that
 * then failed upstream would leave callers with nothing — turning a refresh into
 * an outage. The rows are kept until better ones replace them.
 */
export function refreshCatalog(): void {
  if (catalog) catalog.expiresAt = 0;
}

/**
 * Size, age and successful-fetch count, for diagnostics. Never the rows.
 *
 * `fetches` is the signal a caller compares **across** a `getCatalog()` call:
 * unchanged means no upstream download happened — either a cache hit or a
 * fallback after a failed refresh — and incremented means fresh rows landed.
 */
export function catalogStatus(): {
  cached: boolean;
  count: number;
  ageMs: number | null;
  fetches: number;
} {
  if (!catalog) return { cached: false, count: 0, ageMs: null, fetches: successfulFetches };
  return {
    cached: true,
    count: catalog.products.length,
    ageMs: Date.now() - catalog.fetchedAt,
    fetches: successfulFetches,
  };
}
