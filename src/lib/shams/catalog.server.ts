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
import { normalizeProductDetail, normalizeProducts, normalizeStock } from "./normalize";
import type {
  RawProductInfoResponse,
  RawProductSearchResponse,
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
 * Free-text catalog search.
 *
 * Matching is the API's own and is substring-based over the item name — the
 * capture shows `q=moun` and the full name `mounjaro 2.5 mg 0.5ml pen, 4's`
 * both resolving, the latter to a single row. Queries shorter than
 * `MIN_SEARCH_LENGTH` return empty without a request rather than sweeping the
 * catalog.
 */
export async function searchProducts(query: string): Promise<ShamsProduct[]> {
  const q = query.trim();
  if (q.length < MIN_SEARCH_LENGTH) return [];

  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return cached;

  const body = await shamsFetch<RawProductSearchResponse>("/api/v2/product/search", { q });
  const products = normalizeProducts(body?.data).slice(0, MAX_SEARCH_RESULTS);
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
