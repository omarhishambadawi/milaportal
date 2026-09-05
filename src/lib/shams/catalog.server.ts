/**
 * Shams product catalog reads (server-only).
 *
 * Three reads, each with a cache sized to how fast the thing behind it actually
 * moves:
 *
 *   search  5 min   a name-to-code lookup over the **local** catalogue in
 *                   Postgres — no upstream request of any kind
 *   info   15 min   price and name for one item, from the MIS; the most static
 *                   thing here
 *   stock  60 s     branch quantities move continuously — a stale figure sends
 *                   an agent to a branch that has just sold the last unit
 *
 * The caches are per-isolate and in-memory (see `TtlCache`). Search's cache is
 * no longer load-bearing — the query behind it is an indexed read of our own
 * database — but a search-as-you-type field re-asks the same term constantly,
 * and this keeps a repeated query from reaching the database at all.
 *
 * **Product discovery never contacts Shams.** The catalogue is
 * `shams_product_catalog`, filled in the background; see `searchProducts`. Only
 * `info` and `stock` go upstream, and only for a product an agent has selected.
 *
 * **Stock is never fetched for a search result set.** Availability for twelve
 * hits is twelve requests returning ~136 rows each; callers ask for stock on the
 * one item a user actually opened.
 */

import { shamsFetch, ShamsError, TtlCache } from "./client.server";
import { normalizeProductDetail, normalizeStock } from "./normalize";
import {
  isWildcardQuery,
  looksLikeItemCode,
  matchesProductQuery,
  matchesProductWildcard,
  normalizeForSearch,
  parseWildcardQuery,
  rankProducts,
} from "./search";
import { escapeLikePattern, fetchCatalogCandidates } from "./catalog-store.server";
import type { CatalogCandidateQuery } from "./catalog-store.server";
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
 * The `LIKE` patterns that retrieve everything a query could match.
 *
 * The one place the SQL side and the matching side have to agree, so it is
 * written to make the agreement obvious rather than probable:
 *
 *   plain     `%needle%` against the name; the code exactly, and by prefix when
 *             the query looks like an item code — the three arms of
 *             `matchesProductQuery`, one for one.
 *   wildcard  `%f1%f2%…%` against both fields. `LIKE` with `%` between fragments
 *             *is* `matchesWildcard`: each fragment found after the previous one
 *             ended, in order, without overlap.
 *
 * Whatever an agent typed is escaped first, so a `%` in `50% CREAM` is a percent
 * sign rather than a wildcard the syntax never offered them.
 *
 * Retrieval is allowed to be wider than matching but never narrower, and here it
 * is exactly as wide: `searchProducts` re-checks every row against the pure
 * predicates anyway, so a divergence can only ever cost a result, never invent
 * one.
 */
function candidateQuery(q: string, fragments: string[]): CatalogCandidateQuery {
  if (fragments.length > 0) {
    const pattern = `%${fragments.map(escapeLikePattern).join("%")}%`;
    return { namePattern: pattern, codePattern: pattern };
  }

  const needle = escapeLikePattern(normalizeForSearch(q));
  return {
    namePattern: needle === "" ? null : `%${needle}%`,
    // The exact code is a prefix of itself, so one pattern serves both arms when
    // the query looks like a code; otherwise only the exact match is offered.
    codePattern: looksLikeItemCode(q) ? `${escapeLikePattern(q)}%` : escapeLikePattern(q),
  };
}

/**
 * Free-text catalog search, over the **local** Shams product catalogue.
 *
 * ## Why this no longer touches Shams CRM
 *
 * It used to match against `getCrmProducts()`: the whole `/products/names`
 * catalogue, downloaded on demand and held in an in-memory, per-isolate cache.
 * That cache is cold after every deploy and in every new isolate, and a cold
 * cache made the first search of a shift pay a CRM login plus a 700 KB download
 * before a single row appeared — during a live call, on the AHT clock, with an
 * outage at `shams-crm.cloud` turning "slow" into "no results at all".
 *
 * The catalogue now lives in Postgres (`shams_product_catalog`), seeded at
 * migration time and refreshed in the background by
 * `lib/shams-crm/catalog-sync.server.ts`. A search is one indexed query against
 * it. **No agent-facing search path contacts Shams CRM**, so a CRM outage costs
 * freshness — a price that may be a few hours old — and never an answer.
 *
 * This function is product **discovery** only. Stock, availability, invoices and
 * branch data stay on the MIS, and `getProductDetail` / `getProductStock` below
 * are untouched — a product found here is looked up there by its item code,
 * exactly as before, and only once an agent has selected one.
 *
 * ## Matching is unchanged
 *
 * The same pure rules from `lib/shams/search.ts`, applied to the same three
 * fields: case- and whitespace-insensitive, `*` as ordered fragments,
 * `rankProducts` for ordering, capped at `MAX_SEARCH_RESULTS`. The database
 * narrows 8,484 rows to the candidates; it does not rank them and it does not
 * decide how many an agent sees. What is genuinely new is the item-code
 * **prefix** arm — see `matchesProductQuery` — which the catalogue's own index
 * makes free and which no previous source could retrieve at all.
 *
 * The candidates are re-checked in TypeScript rather than trusted from SQL. It
 * costs a filter over at most a few hundred rows and it means `search.ts` stays
 * the single authority on what a match is: if a stored `search_name` were ever
 * written by something other than `normalizeForSearch`, the effect is a missing
 * result, not a wrong one.
 *
 * The per-query result cache is kept, unchanged. It is a smaller win than it was
 * — the query behind it is now milliseconds — but a search-as-you-type field
 * still re-asks for the same term constantly, and this is what keeps a repeated
 * query from reaching the database at all.
 */
export async function searchProducts(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<ShamsProduct[]> {
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

  // The same floors as before. A one-character query still matches most of the
  // catalog and returning it is not an answer.
  const searchable = wildcard
    ? fragments.some((fragment) => fragment.length >= MIN_SEARCH_LENGTH)
    : q.length >= MIN_SEARCH_LENGTH;
  if (!searchable) return [];

  // Throws when the local catalogue cannot be read. Deliberately not caught
  // here: the MIS must not silently become a second product source, and a
  // database incident must not read as "no products found".
  const candidates = await fetchCatalogCandidates(candidateQuery(q, fragments), {
    signal: options.signal,
  });

  const matched = wildcard
    ? candidates.filter((product) => matchesProductWildcard(product, fragments))
    : candidates.filter((product) => matchesProductQuery(product, q));

  const products = rankProducts(matched, q, fragments).slice(0, MAX_SEARCH_RESULTS);

  /*
   * An abandoned query's result is not cached.
   *
   * A cancelled read resolves as no candidates rather than as an error (see
   * `fetchCatalogCandidates`), and caching that under the term would mean the
   * agent who types the same thing a moment later is told there are no matches
   * for five minutes.
   */
  if (!options.signal?.aborted) searchCache.set(key, products);
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
