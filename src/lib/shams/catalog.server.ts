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
import {
  isWildcardQuery,
  looksLikeItemCode,
  matchesProductWildcard,
  parseWildcardQuery,
  rankProducts,
  wildcardProbes,
} from "./search";
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
/**
 * Upstream requests one wildcard search may issue.
 *
 * Three, because the point is insurance against a server-side result cap
 * nobody has been able to measure — the endpoint exposes no `limit`, `page` or
 * `offset` — not breadth for its own sake. A plain search still costs exactly
 * one request, and no query can cost more than this however many `*` it carries.
 */
export const MAX_SEARCH_PROBES = 3;

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
 * Free-text catalog search, with `*` wildcards.
 *
 * Without a `*` this is the API's own matching: substring over the item name —
 * the capture shows `q=moun` and the full name `mounjaro 2.5 mg 0.5ml pen, 4's`
 * both resolving, the latter to a single row. Queries shorter than
 * `MIN_SEARCH_LENGTH` return empty without a request rather than sweeping the
 * catalog.
 *
 * ## Wildcards, and why they are applied here
 *
 * `mou*n*j*2.5` means "these fragments, in this order, anything in between".
 * **The MIS API has no such syntax.** Its only search parameter is `q`, matched
 * as a plain substring (verified against the portal's own bundle, which builds
 * `/product/search?q=` and nothing else), so forwarding the asterisks literally
 * would search for a product whose name contains a `*` and return nothing.
 *
 * So the expression is split: one fragment goes upstream as an ordinary term to
 * pull candidates, and the full ordered match is applied to the rows that come
 * back. That is correct rather than approximate — every product satisfying the
 * whole expression must contain each individual fragment, so a single-fragment
 * search is guaranteed to be a superset of the answer.
 *
 * Filtering happens **before** the result cap, so a wildcard match cannot be
 * truncated away by candidates it was going to reject anyway.
 */
export async function searchProducts(query: string): Promise<ShamsProduct[]> {
  const q = query.trim();
  if (q === "") return [];

  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return cached;

  const fragments = isWildcardQuery(q) ? parseWildcardQuery(q) : [];
  const wildcard = fragments.length > 0;

  // The upstream terms: the whole query when it is plain, the most selective
  // fragments when it is an expression.
  const probes = wildcard
    ? wildcardProbes(fragments, MIN_SEARCH_LENGTH, MAX_SEARCH_PROBES)
    : q.length >= MIN_SEARCH_LENGTH
      ? [q]
      : [];
  // A pure code lookup still has a probe, since MIN_ITEM_CODE_LENGTH exceeds
  // MIN_SEARCH_LENGTH; this stays the guard for queries too short for either.
  if (probes.length === 0) return [];

  /**
   * An item code is not searchable through `product/search`.
   *
   * That endpoint matches a **substring of the item name** and nothing else
   * (see docs/shams/api-discovery.md §3.1), so pasting `10400746` searched the
   * catalog for a *name* containing those digits and found nothing — the one
   * lookup an agent holding a document is most likely to want.
   *
   * `product/info?itemcode=` is the endpoint that does answer it, exactly. So a
   * query that looks like a code asks both, in parallel, and the answers are
   * merged. It is additive, never exclusive: `10400746` is still searched as a
   * name too, so the field never has to be told which kind of thing was typed.
   *
   * Exact only. `product/info` takes a whole code and `product/search` cannot
   * see codes at all, so a *partial* code has nothing upstream that can answer
   * it — that is an API limit, not a decision made here.
   */
  const codeLookup = looksLikeItemCode(q) ? getProductDetail(q).catch(() => null) : null;

  // Probes run together — they are independent, and a wildcard search should
  // not cost the agent one round trip per fragment.
  const [responses, byItemCode] = await Promise.all([
    Promise.all(
      probes.map((term) =>
        shamsFetch<RawProductSearchResponse>("/api/v2/product/search", { q: term }),
      ),
    ),
    codeLookup,
  ]);

  // Union, de-duplicated by item code. First sighting wins, so the most
  // selective probe's ordering survives into the ranking below.
  const byCode = new Map<string, ShamsProduct>();
  // The exact code match goes in first, so it survives de-duplication and — via
  // `scoreProduct`'s code band — sorts to the top.
  if (byItemCode) {
    byCode.set(byItemCode.itemCode, {
      itemCode: byItemCode.itemCode,
      itemName: byItemCode.itemName,
      retailPrice: byItemCode.retailPrice,
    });
  }
  for (const body of responses) {
    for (const product of normalizeProducts(body?.data)) {
      if (!byCode.has(product.itemCode)) byCode.set(product.itemCode, product);
    }
  }

  const candidates = [...byCode.values()];
  const matched = wildcard
    ? candidates.filter((product) => matchesProductWildcard(product, fragments))
    : candidates;

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
