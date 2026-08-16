/**
 * Shams product catalog reads (server-only).
 *
 * Three endpoints, each with a cache sized to how fast the thing behind it
 * actually moves:
 *
 *   search  5 min   a name-to-code lookup over a catalog that changes daily at most
 *   info   15 min   price and name for one item; the most static thing here
 *   stock  60 s     branch quantities move continuously — a stale figure sends
 *                   an agent to a branch that has just sold the last unit
 *
 * The caches are per-isolate and in-memory (see `TtlCache`). Their real job is
 * search: the MIS portal issues a request per keystroke (`moun`, `mounj`,
 * `mounjaro` all appear in the capture), and without a cache the portal would
 * forward that keystroke traffic upstream.
 *
 * **Stock is never fetched for a search result set.** Availability for twelve
 * hits is twelve requests returning ~136 rows each; callers ask for stock on the
 * one item a user actually opened.
 */

import { shamsFetch, ShamsError, TtlCache } from "./client.server";
import { normalizeProductDetail, normalizeStock } from "./normalize";
import {
  isWildcardQuery,
  matchesProductWildcard,
  normalizeForSearch,
  parseWildcardQuery,
  rankProducts,
} from "./search";
import { getCrmProducts } from "@/lib/shams-crm/products.server";
import type {
  RawProductInfoResponse,
  RawStockResponse,
  ShamsBranchStock,
  ShamsProduct,
  ShamsProductDetail,
} from "./types";

const SEARCH_TTL_MS = 5 * 60_000;
const INFO_TTL_MS = 15 * 60_000;
const STOCK_TTL_MS = 60_000;

/** Shortest query forwarded upstream. One letter matches most of the catalog. */
export const MIN_SEARCH_LENGTH = 2;
/** Cap on rows handed back to a caller, whatever the catalog returns. */
export const MAX_SEARCH_RESULTS = 100;

const searchCache = new TtlCache<ShamsProduct[]>(SEARCH_TTL_MS);
const infoCache = new TtlCache<ShamsProductDetail | null>(INFO_TTL_MS);
const stockCache = new TtlCache<ShamsBranchStock[]>(STOCK_TTL_MS);

/** Test seam; also lets a diagnostics surface force a cold read. */
export function _clearCaches(): void {
  searchCache.clear();
  infoCache.clear();
  stockCache.clear();
}

/**
 * Free-text catalog search, over the Shams CRM catalog.
 *
 * **The catalog comes from the CRM, not the MIS.** `product/search` returns at
 * most 50 rows with no pagination, so a broad query was truncated before the
 * wanted product was ever seen — `nan` matched 53+ products and the NAN OPTIPRO
 * range fell outside the 50 that came back. The CRM's `/products/names` returns
 * all ~8,484 rows in one cached response, so matching now runs over the whole
 * catalog and the cap is gone.
 *
 * This function is product **discovery** only. Stock, availability, invoices and
 * branch data stay on the MIS, and `getProductDetail` / `getProductStock` below
 * are untouched — a product found here is looked up there by its item code,
 * exactly as before.
 *
 * ## Matching is unchanged
 *
 * The same pure rules as before, from `lib/shams/search.ts`: case- and
 * whitespace-insensitive, `*` as ordered fragments, `rankProducts` for ordering,
 * capped at `MAX_SEARCH_RESULTS`. What changed is only *which products are
 * available to match against*. A plain query matches a substring of the item
 * name — what the MIS did upstream — plus an exact item code, which used to cost
 * a separate `product/info` request and is now a scan of rows already in hand.
 *
 * The per-query result cache is kept: matching 8,484 rows is cheap, but a
 * search-as-you-type field would otherwise redo it on every keystroke.
 */
export async function searchProducts(query: string): Promise<ShamsProduct[]> {
  const q = query.trim();
  if (q === "") return [];

  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return cached;

  const fragments = isWildcardQuery(q) ? parseWildcardQuery(q) : [];
  const wildcard = fragments.length > 0;

  // A query carrying a `*` is an expression, even when nothing survives the
  // split: `***` is "match everything", which is not a search.
  if (isWildcardQuery(q) && !wildcard) return [];

  // The same floors as before. They no longer protect an upstream request —
  // there is none — but a one-character query still matches most of the catalog
  // and returning it is not an answer.
  const searchable = wildcard
    ? fragments.some((fragment) => fragment.length >= MIN_SEARCH_LENGTH)
    : q.length >= MIN_SEARCH_LENGTH;
  if (!searchable) return [];

  // Throws when the catalog cannot be loaded. Deliberately not caught here: the
  // MIS must not silently become a second product source, and an outage must not
  // read as "no products found".
  const catalog = await getCrmProducts();

  const needle = normalizeForSearch(q);
  const matched = wildcard
    ? catalog.filter((product) => matchesProductWildcard(product, fragments))
    : catalog.filter(
        (product) =>
          normalizeForSearch(product.itemName).includes(needle) || product.itemCode === q,
      );

  const products = rankProducts(matched, q, fragments).slice(0, MAX_SEARCH_RESULTS);
  searchCache.set(key, products);
  return products;
}

/**
 * One item's name and price, or `null` when the code is unknown.
 *
 * An unknown item code is **not** an error: the API answers `200` with an empty
 * payload rather than a 404, so a missing product is modelled as absence and
 * only genuine transport failures raise.
 */
export async function getProductDetail(itemCode: string): Promise<ShamsProductDetail | null> {
  const code = itemCode.trim();
  if (!code) return null;

  const cached = infoCache.get(code);
  if (cached !== undefined) return cached;

  const body = await shamsFetch<RawProductInfoResponse>("/api/v2/product/info", {
    itemcode: code,
  });
  const detail = normalizeProductDetail(body?.data);
  infoCache.set(code, detail);
  return detail;
}

/**
 * Branch-level availability for one item.
 *
 * Returns every branch the MIS reports, including zero-quantity ones, because
 * "stocked nowhere" and "unknown item" are different answers and the caller
 * needs to tell them apart. `branchCode` is directly comparable to
 * `branches.branch_no`.
 */
export async function getProductStock(itemCode: string): Promise<ShamsBranchStock[]> {
  const code = itemCode.trim();
  if (!code) return [];

  const cached = stockCache.get(code);
  if (cached) return cached;

  const body = await shamsFetch<RawStockResponse>("/api/v2/product/stock", { itemcode: code });
  const stock = normalizeStock(body?.data);
  stockCache.set(code, stock);
  return stock;
}

/**
 * Items resolved at once by `getStockForItems`.
 *
 * `product/stock` takes exactly one `itemcode` — the portal's own bundle builds
 * `/product/stock?itemcode=` and nothing else — so there is no batch form to
 * reach for and a document's lines cost one request each. Six at a time is the
 * middle ground: a typical invoice of three or four items resolves in a single
 * wave, and a long one cannot open dozens of upstream connections at once. It
 * is deliberately far below the branch sweep's 24, because this runs *after* a
 * sweep rather than instead of one.
 */
const STOCK_CONCURRENCY = 6;

/**
 * Ceiling on items one call will resolve.
 *
 * A guard, not a product decision: no captured document comes close, and the
 * cost of a pathological one is bounded rather than discovered in production.
 * Items past the cap are simply absent from the map, which reads as `unknown`.
 */
const MAX_STOCK_ITEMS = 40;

/**
 * Branch availability for several items, keyed by item code.
 *
 * Built on `getProductStock`, so every item goes through the same 60 s cache as
 * the Branch Stock tab: an item already looked at there costs nothing here, and
 * two invoices sharing a product cost one request between them.
 *
 * **A failure is an omission, not an exception.** One item the MIS will not
 * answer for must not cost the caller the other four — the map simply has no
 * entry for it, which `branchStockState` reads as `unknown` rather than as zero.
 * Only the caller's own decision to ask can fail this function, and it cannot.
 */
export async function getStockForItems(
  itemCodes: readonly string[],
): Promise<Map<string, ShamsBranchStock[]>> {
  const codes = [...new Set(itemCodes.map((c) => c.trim()).filter(Boolean))].slice(
    0,
    MAX_STOCK_ITEMS,
  );
  const out = new Map<string, ShamsBranchStock[]>();
  if (codes.length === 0) return out;

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= codes.length) return;
      const code = codes[index];
      try {
        out.set(code, await getProductStock(code));
      } catch {
        // Left out of the map on purpose — see the note above.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(STOCK_CONCURRENCY, codes.length) }, () => worker()),
  );
  return out;
}

/**
 * Detail plus availability for one item, in parallel.
 *
 * The pairing the UI actually wants when a user opens a product. Kept here so
 * the two requests overlap rather than being serialized by a caller.
 */
export async function getProductWithStock(itemCode: string): Promise<{
  product: ShamsProductDetail | null;
  stock: ShamsBranchStock[];
}> {
  const [product, stock] = await Promise.all([
    getProductDetail(itemCode),
    getProductStock(itemCode).catch((err) => {
      // Availability is the softer half: a product still renders without it.
      if (err instanceof ShamsError) return [] as ShamsBranchStock[];
      throw err;
    }),
  ]);
  return { product, stock };
}
