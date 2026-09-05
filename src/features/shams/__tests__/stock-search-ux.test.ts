/**
 * What Branch Stock's search must never do to an agent mid-call.
 *
 * Nothing here renders. What is asserted is wiring that is invisible to the type
 * checker and that a plausible-looking edit could quietly undo — and every rule
 * below is one an agent feels directly, on the phone, on the AHT clock:
 *
 *   * one live stock request, for the product they actually opened, and never
 *     one per search result;
 *   * a result list that dims rather than vanishing while the next term loads;
 *   * a loading state that always ends, in results, an empty state or an error
 *     with a Retry — never in a skeleton nobody comes back for;
 *   * no upstream catalogue download anywhere on the path.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const hook = read("../hooks/use-shams-data.ts");
const stockTab = read("../components/stock-tab.tsx");
const functions = read("../../../lib/shams.functions.ts");
const catalog = read("../../../lib/shams/catalog.server.ts");

/* -------------------------------------------------------------------------- */
/* Stock is only ever fetched for a selected product                           */
/* -------------------------------------------------------------------------- */

describe("live MIS stock waits for a selection", () => {
  it("is disabled until a product is chosen", () => {
    // The hook that would otherwise turn a hundred-row result set into a
    // hundred upstream stock requests.
    expect(stockTab).toContain("useProductDetail(selected?.itemCode ?? null, Boolean(selected))");
    expect(hook).toContain("enabled: enabled && Boolean(itemCode),");
  });

  it("is not reached from the search path at all", () => {
    /*
     * `searchProducts` must never call the stock or info readers. It shares a
     * module with both, so the containment is a property of the function rather
     * than of the file, and it is worth asserting: a helpful-looking edit that
     * enriched results with availability would cost one upstream request per
     * row, per keystroke.
     */
    const search = catalog.slice(
      catalog.indexOf("export async function searchProducts("),
      catalog.indexOf("export async function getProductDetail("),
    );
    expect(search).not.toContain("getProductStock");
    expect(search).not.toContain("getProductDetail");
    expect(search).not.toContain("shamsFetch");
  });

  it("keeps the MIS reads themselves untouched", () => {
    // Only discovery moved to the local catalogue. Stock is still live, still
    // the MIS, still per selected item.
    expect(catalog).toContain('shamsFetch<RawStockResponse>("/api/v2/product/stock"');
    expect(catalog).toContain("const STOCK_TTL_MS = 60_000;");
  });
});

/* -------------------------------------------------------------------------- */
/* Search never depends on a CRM download                                      */
/* -------------------------------------------------------------------------- */

describe("search reads the local catalogue", () => {
  it("retrieves candidates from Postgres, not from an upstream catalogue", () => {
    expect(catalog).toContain("fetchCatalogCandidates(candidateQuery(q, fragments)");
    expect(catalog).not.toContain('from "@/lib/shams-crm/products.server"');
  });

  it("still ranks and caps in the pure matcher, not in SQL", () => {
    // The agent-facing behaviour — which product is first, how many are shown —
    // stays in one unit-tested place rather than being half expressed in SQL.
    expect(catalog).toContain("rankProducts(matched, q, fragments).slice(0, MAX_SEARCH_RESULTS)");
  });

  it("re-checks candidates against the pure predicates", () => {
    expect(catalog).toContain("matchesProductWildcard(product, fragments)");
    expect(catalog).toContain("matchesProductQuery(product, q)");
  });

  it("forwards the request's abort signal to the database read", () => {
    expect(functions).toContain("signal = getRequest()?.signal;");
    expect(functions).toContain("await searchProducts(data.q, { signal })");
  });

  it("does not cache the empty result of a cancelled search", () => {
    expect(catalog).toContain("if (!options.signal?.aborted) searchCache.set(key, products);");
  });
});

/* -------------------------------------------------------------------------- */
/* The loading experience                                                      */
/* -------------------------------------------------------------------------- */

describe("typing", () => {
  it("keeps the 350 ms debounce", () => {
    // Unchanged deliberately. It was never the problem, and shortening it now
    // that the server answers in milliseconds would only mean searching
    // mid-word.
    expect(hook).toContain("const DEBOUNCE_MS = 350;");
  });

  it("keeps the previous result list on screen while the next one loads", () => {
    expect(hook).toContain("placeholderData: (previous) => previous");
    expect(stockTab).toContain("searchQuery.isFetching && searchQuery.isPlaceholderData");
    expect(stockTab).toContain("busy={stale}");
  });

  it("does not show results for a term the agent has erased", () => {
    /*
     * The trap that comes with `placeholderData`: it survives the query being
     * disabled too, so deleting back to one character would otherwise leave the
     * previous term's products on screen looking current.
     */
    expect(stockTab).toContain("const searchable = term.trim().length >= MIN_QUERY_LENGTH;");
    expect(stockTab).toContain("searchable ? (searchQuery.data?.products ?? []) : []");
  });

  it("bounds the request, so a skeleton always ends in something", () => {
    expect(hook).toContain("const SEARCH_TIMEOUT_MS = 15_000;");
    expect(hook).toContain("withTimeout(signal, SEARCH_TIMEOUT_MS,");
  });

  it("shows the skeleton only when there is genuinely nothing to show", () => {
    // Keyed on `matches`, not on `data`, which now survives a term change as
    // placeholder data and would otherwise leave the panel blank.
    expect(stockTab).toContain(
      "{searchable && searchQuery.isFetching && matches.length === 0 && <TableSkeleton rows={4} />}",
    );
  });

  it("says so when a finished search found nothing", () => {
    expect(stockTab).toContain(
      "{searchable && !searchQuery.isFetching && searchQuery.data?.ok && matches.length === 0 && (",
    );
    expect(stockTab).toContain("No products found for");
  });

  it("offers a retry on both kinds of failure", () => {
    expect(stockTab).toContain("{searchQuery.isError && <ErrorState onRetry={");
    expect(stockTab).toContain("<ErrorState kind={searchQuery.data.error?.kind} onRetry={");
  });

  it("does not show a stale failure over live results", () => {
    expect(stockTab).toContain("{!searchQuery.isPlaceholderData && searchQuery.data &&");
  });

  it("prompts when the term is too short to search", () => {
    expect(stockTab).toContain("{!searchable && !searchQuery.isFetching && (");
    expect(stockTab).toContain("Search for a product to see its stock across branches.");
  });
});

/* -------------------------------------------------------------------------- */
/* Failure copy                                                                */
/* -------------------------------------------------------------------------- */

describe("a local incident does not read as a Shams outage", () => {
  const constants = read("../constants.ts");

  it("has its own copy for a catalogue failure", () => {
    expect(constants).toContain("catalog_unavailable:");
    expect(constants).toContain("catalog_empty:");
  });

  it("does not blame Shams for it", () => {
    const copy = constants.slice(constants.indexOf("catalog_unavailable:"));
    expect(copy.slice(0, 200)).not.toMatch(/Shams/);
  });
});
