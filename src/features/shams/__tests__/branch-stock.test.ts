/**
 * What Branch Stock must answer, and what it must never ask for twice.
 *
 * Nothing here renders — this suite is `environment: "node"` like the rest, and
 * the page's pure rules live in `lib/shams/search.ts` where they are tested
 * directly. What is asserted here is **wiring**: the joins between a hook, a
 * server function and a cell that the type checker cannot see and that a
 * plausible-looking edit could quietly undo.
 *
 * Every rule below is one an agent feels on a live call:
 *
 *   * price and the applied offer are on the card the moment a product opens,
 *     because three of the card's four figures cost no request at all;
 *   * the offer is asked for **once** — one query key, primed early, read in
 *     one place — and never on a timer;
 *   * a branch row's price and offer belong to that branch and no other;
 *   * the Arabic city and the حي come from the portal's own branch directory,
 *     on the read it was already making;
 *   * live stock is still Shams MIS, and nothing on this page changed that.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const stockTab = read("../components/stock-tab.tsx");
const hook = read("../hooks/use-shams-data.ts");
const search = read("../../../lib/shams/search.ts");
const functions = read("../../../lib/shams.functions.ts");
const catalog = read("../../../lib/shams/catalog.server.ts");
const offersServer = read("../../../lib/shams-crm/offers.server.ts");

/** The `ProductSummaryCard` body, so a match cannot come from the table below. */
const summaryCard = stockTab.slice(
  stockTab.indexOf("function ProductSummaryCard({"),
  stockTab.indexOf("function Figure({"),
);

/** Everything the tab renders once a product is open. */
const openedProduct = stockTab.slice(
  stockTab.indexOf("      <ProductSummaryCard"),
  stockTab.indexOf("type OfferState ="),
);

/** The desktop register plus its mobile twin. */
const table = stockTab.slice(
  stockTab.indexOf("const BranchStockTable = memo("),
  stockTab.indexOf("function StockStatus({"),
);

/* -------------------------------------------------------------------------- */
/* The summary card answers the call                                           */
/* -------------------------------------------------------------------------- */

describe("the product card", () => {
  it("shows the price of the selected product", () => {
    // `product` is the row the agent clicked, so this is the price of *that*
    // item and can be nothing else.
    expect(summaryCard).toContain('<Figure label="Price">');
    expect(summaryCard).toContain("{fmtSAR(product.retailPrice)}");
    expect(openedProduct).toContain("product={selected}");
  });

  it("shows the price without waiting for a request", () => {
    /*
     * The point of the whole change. `retailPrice` travels on the search row
     * the agent clicked — and, for a restored `?item=`, on the detail the route
     * already loaded — so the price is on screen in the same frame as the name.
     * Nothing in the card reads it off the stock or offer response.
     */
    expect(summaryCard).not.toContain("stockQuery");
    expect(summaryCard).not.toContain("offersQuery");
    expect(summaryCard).not.toContain("result?.product");
  });

  it("shows the applied offer, with its coverage", () => {
    expect(summaryCard).toContain('<Figure label="Applied offer">');
    expect(summaryCard).toContain("<AppliedOffer scope={scope}");
    // "On offer" alone is a promise the agent cannot keep — the branch the
    // customer walks into decides whether it applies.
    expect(stockTab).toContain('{all ? "all branches" : "some branches"}');
  });

  it("takes the offer for the opened product and no other", () => {
    // Authoritative source first: the same response that priced the rows below,
    // so the card and the table cannot disagree. The fallback is keyed on the
    // opened item's own code, so a neighbouring result's promotion can never
    // land on this card.
    expect(stockTab).toContain("offersQuery.data?.ok ? offersQuery.data.scope : null");
    expect(stockTab).toContain("scopes.byItemCode.get(selected.itemCode)");
  });

  it("shows the units the MIS returned for this product", () => {
    expect(summaryCard).toContain('<Figure label="Units in stock">');
    expect(openedProduct).toContain("units={totalSummary.units}");
    // `totalSummary` is `summariseStock(stock)` — the unfiltered MIS rows, so
    // the card states the chain-wide fact while the table may be filtered.
    expect(stockTab).toContain(
      "const totalSummary = useMemo(() => summariseStock(stock), [stock]);",
    );
  });

  it("shows how many branches actually have it", () => {
    expect(summaryCard).toContain('<Figure label="Branches with stock">');
    expect(openedProduct).toContain("branchesWithStock={totalSummary.withStock}");
    expect(openedProduct).toContain("branchesTotal={totalSummary.branches}");
    // `withStock` counts rows with a positive quantity, from the authoritative
    // stock flow — not rows returned, which is every branch in the chain.
    expect(search).toContain("if (row.quantity > 0) {");
  });

  it("stays readable while the offer is still in flight", () => {
    // The card is never frozen behind the CRM: the three figures that cost no
    // request are already drawn, and the offer says what it is doing.
    expect(stockTab).toContain("Checking…");
    expect(openedProduct).toContain("offerState={offerState}");
    expect(stockTab).toContain("const offerState: FigureState = offersQuery.isPending");
  });

  it("never reports an unasked question as 'no offer'", () => {
    // A CRM that could not be reached is not evidence about a promotion.
    expect(stockTab).toContain(
      'if (state === "unavailable" || !scope || scope.kind === "unknown") {',
    );
    expect(stockTab).toContain("Not checked");
  });
});

/* -------------------------------------------------------------------------- */
/* One offer request, and never a repeating one                                */
/* -------------------------------------------------------------------------- */

describe("offer loading", () => {
  it("asks for the opened product's offers exactly once", () => {
    // One `useProductOffers` call in the tab. The card and the table read the
    // same query — a second observer here would be a second round trip for an
    // answer the page already has.
    expect(stockTab.match(/useProductOffers\(/g)).toHaveLength(1);
    expect(stockTab).toContain("const offersQuery = useProductOffers(selected?.itemCode ?? null);");
  });

  it("primes that same query rather than opening a second one", () => {
    /*
     * The regression this exists to catch. `usePrefetchProductOffers` starts
     * the CRM read on the click, so it overlaps the router navigation instead
     * of queueing behind it — and it is only *not* a duplicate because it uses
     * the identical query key. Change one of these two and the page makes two
     * ~62 KB upstream requests per product opened.
     */
    const prefetch = hook.slice(
      hook.indexOf("export function usePrefetchProductOffers()"),
      hook.indexOf("/* ---", hook.indexOf("export function usePrefetchProductOffers()")),
    );
    expect(prefetch).toContain("queryKey: queryKeys.shams.productOffers(itemCode),");
    expect(prefetch).toContain("staleTime: OFFERS_STALE_MS,");
    expect(hook).toContain('queryKey: queryKeys.shams.productOffers(itemCode ?? ""),');
    // Verbatim on both sides. Normalizing the code in one place and not the
    // other is how "one key" quietly becomes two.
    expect(prefetch).not.toMatch(/productOffers\((?!itemCode\))/);
    // Called from the click, not from hover or from the keyboard highlight:
    // prefetching a list as a cursor runs down it is exactly the traffic the
    // scope cap exists to prevent.
    expect(stockTab).toContain("prefetchOffers(product.itemCode);");
    expect(stockTab).not.toContain("onMouseEnter={() => prefetch");
  });

  it("does not fan out offers for a result set nobody is looking at", () => {
    expect(stockTab).toContain("const scopes = useOfferScopes(resultCodes, !selected);");
    expect(hook).toContain("enabled: enabled && within,");
  });

  it("keeps the server's single upstream read behind both answers", () => {
    // Coverage and per-branch prices come out of one 62 KB response, so an
    // opened product costs one CRM request however many questions are asked of
    // it. This is what makes the prefetch cheap and the card instant.
    expect(offersServer).toContain("const pending = inFlight.get(code);");
    expect(functions).toContain("getProductOffer(data.itemCode),");
    expect(functions).toContain("getProductOfferScope(data.itemCode),");
  });

  it("adds no polling anywhere on the page", () => {
    for (const source of [stockTab, hook]) {
      expect(source).not.toContain("refetchInterval");
      expect(source).not.toContain("refetchIntervalInBackground");
      expect(source).not.toContain("setInterval");
    }
    // Nor a refocus refetch, which is the same thing with extra steps for an
    // agent alt-tabbing between the portal and a call.
    expect(hook).toContain("refetchOnWindowFocus: false,");
  });
});

/* -------------------------------------------------------------------------- */
/* City and district come from the portal's own directory                      */
/* -------------------------------------------------------------------------- */

describe("city and district", () => {
  it("reads both off the branches table, in one select", () => {
    // `address` joins the existing two columns rather than becoming a second
    // query: the district is derived from the address, and asking twice for two
    // columns of one row is the duplicate this work exists to remove.
    expect(hook).toContain('supabase.from("branches").select("branch_no,city,address")');
    expect(hook.match(/from\("branches"\)/g)).toHaveLength(1);
  });

  it("derives the حي with the branch directory's own rule", () => {
    // Not a second, hand-maintained list of districts. `extractDistrict` is
    // conservative by design and returns null rather than guessing, which is
    // what a value an agent reads aloud to a customer has to be.
    expect(hook).toContain('import { extractDistrict } from "@/features/branches/district";');
    expect(hook).toContain("district: extractDistrict(b.address, b.city),");
  });

  it("displays the city in Arabic and the district beside it", () => {
    expect(table).toContain('<th className={cn(TH, "w-[14%]")}>City</th>');
    expect(table).toContain("<th className={TH}>District</th>");
    expect(stockTab).toContain("return { city: hit.city || null, district: hit.district,");
    // `city` is the stored Arabic value; the English name rides in the tooltip.
    expect(stockTab).toContain("const title = [hit.city, hit.cityEnglish, hit.district]");
  });

  it("still renders a branch the directory does not know", () => {
    expect(stockTab).toContain(
      "if (!hit) return { city: null, district: null, title: undefined };",
    );
  });

  it("folds Arabic once per branch rather than once per keystroke", () => {
    // ~140 rows × four fields on every character typed is work with a fixed
    // answer. The directory folds each branch when it loads, the same way
    // `use-branch-directory` decorates its own rows.
    expect(hook).toContain("search: branchSearchText({ ...label, branchCode: b.branch_no })");
    expect(search).toContain("return (row.search ?? branchSearchText(row)).includes(needle);");
  });

  it("searches code, both city spellings and the district — and not the MIS area", () => {
    expect(search).toContain(
      '[row.branchCode, row.city ?? "", row.cityEnglish ?? "", row.district ?? ""].join(" ")',
    );
    // `areaName` is a coarse MIS region label that contradicts the city for some
    // branches. It is not searched and not shown — the mention that survives in
    // this module is the comment explaining why, so the matcher itself is what
    // gets checked.
    const matcher = search.slice(
      search.indexOf("export function matchesBranchQuery("),
      search.indexOf("export type BranchRowLabels"),
    );
    expect(matcher).not.toContain("areaName");
    expect(stockTab).not.toContain("row.areaName");
  });

  it("borrows the portal's one Arabic normalizer rather than writing a second", () => {
    expect(search).toContain('import { foldText } from "@/features/branches/normalize";');
    expect(search).toContain("const needle = foldText(query);");
  });
});

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

describe("the stock table", () => {
  it("carries Price and Applied Offer as separate, adjacent columns", () => {
    const headers = [...table.matchAll(/>([A-Za-z ]+)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual([
      "Branch",
      "City",
      "District",
      "Units",
      "Status",
      "Price",
      "Applied Offer",
    ]);
  });

  it("maps price and offer to the branch on the row", () => {
    // Both keyed on `row.branchCode`, so a promotion cannot arrive from a
    // neighbouring branch and a price cannot arrive from a neighbouring row.
    expect(table).toContain("const offer = offers.get(row.branchCode);");
    expect(table).toContain("{fmtSAR(branchPrice(offer, listPrice))}");
    expect(table).toContain("<OfferCell offer={offer} state={offerState} />");
  });

  it("prices a branch from its own CRM row when there is one", () => {
    // `offer.price` and `offer.afterOfferPrice` come off the same row, so the
    // pair cannot disagree about what is being discounted. A branch the CRM did
    // not price falls back to the product's MIS retail price — the same figure
    // the card above is showing.
    expect(stockTab).toContain("return offer ? offer.price : listPrice;");
    expect(stockTab).toContain("listPrice={selected.retailPrice}");
  });

  it("never derives a discounted price", () => {
    // Rounding is Shams's to decide; a figure computed here could differ from
    // the one the till charges.
    expect(stockTab).toContain("fmtSAR(offer.afterOfferPrice)");
    expect(stockTab).not.toMatch(/offerPercent\s*[/*]/);
  });

  it("aligns every number on its own column", () => {
    expect(table).toContain('<th className={cn(TH, "w-[9%] text-right")}>Units</th>');
    expect(table).toContain('<th className={cn(TH, "w-[13%] text-right")}>Price</th>');
    expect(table).toContain('cn(TD, "py-2 text-right tabular-nums")');
  });

  it("truncates long branch and district names rather than reflowing the row", () => {
    expect(table).toContain("table-fixed");
    expect(table).toContain('cn(TD, "truncate py-2 font-medium")');
    expect(table).toContain('cn(TD, "truncate py-2 text-muted-foreground")');
  });

  it("stays usable on a phone without scrolling sideways", () => {
    expect(table).toContain("md:hidden");
    expect(table).toContain("hidden w-full table-fixed text-sm md:table");
    // Status folds away first, where the quantity's own colour still carries it.
    expect(table).toContain('cn(TH, "hidden w-[12%] lg:table-cell")');
    expect(stockTab).not.toContain("overflow-x");
  });

  it("reads the quantity from the MIS row and nothing else", () => {
    expect(table).toContain('{out ? "0" : row.quantity}');
    expect(stockTab).not.toContain("available_qty");
    expect(stockTab).not.toContain("availableQty");
  });
});

/* -------------------------------------------------------------------------- */
/* The states an agent can end up in                                           */
/* -------------------------------------------------------------------------- */

describe("loading, empty and failure", () => {
  it("never summarises a failed stock read as zero", () => {
    /*
     * `summariseStock([])` is a truthful zero about an empty array and a
     * falsehood about the chain: "0 units, 0 of 0 branches" is what an agent
     * would have read out. A failed read renders an em dash instead, and the
     * error panel below it carries the reason and the Retry — so the card never
     * asserts a figure it does not have, and never holds a pulse that has
     * nothing left to wait for.
     */
    expect(stockTab).toContain("const stockState: FigureState = stockQuery.isPending");
    expect(stockTab).toContain('if (state === "unavailable") {');
    expect(stockTab).toContain(
      '<span className="text-xl font-medium text-muted-foreground sm:text-2xl">—</span>',
    );
    expect(openedProduct).toContain("stockState={stockState}");
  });

  it("shows a skeleton only while there is genuinely nothing to show", () => {
    expect(openedProduct).toContain("{stockQuery.isFetching && !result && <TableSkeleton />}");
    // Refetching the same item keeps the rows on screen — React Query holds
    // data across a refetch of one key, so a 60 s refresh never blanks a table
    // an agent is reading. It is deliberately not carried *across* item codes.
    expect(hook).not.toContain(
      "placeholderData: (previous) => previous,\n    refetchOnWindowFocus: false,\n    retry: false,\n  });\n}\n\n/**\n * CRM offer",
    );
  });

  it("says so when the MIS returned no branches for the item", () => {
    expect(openedProduct).toContain("Shams MIS returned no branch stock for this item.");
  });

  it("says so when a filter matched nothing", () => {
    expect(openedProduct).toContain("No branch matches “{deferredFilter.trim()}”.");
  });

  it("offers a retry on a stock failure, and distinguishes 'not configured'", () => {
    expect(openedProduct).toContain("{stockQuery.isError && <ErrorState onRetry={");
    expect(openedProduct).toContain("<ErrorState kind={result.error?.kind} onRetry={");
    expect(openedProduct).toContain("{result && !result.configured && <NotConfiguredState />}");
  });

  it("explains an empty Applied Offer column instead of leaving it blank", () => {
    expect(table).toContain('{offerState === "unavailable" && (');
    expect(table).toContain("Offer pricing is unavailable");
  });

  it("lets an offer failure leave the stock table exactly as it was", () => {
    // Offers are an enhancement. The tab has no error state for them and never
    // blocks on them; the column empties and the note above says why.
    expect(functions).toContain("return { ok: false, offers: [], scope: null, error: null };");
    expect(openedProduct).not.toContain("offersQuery.isError");
  });
});

/* -------------------------------------------------------------------------- */
/* Source boundaries                                                           */
/* -------------------------------------------------------------------------- */

describe("nothing about where the numbers come from changed", () => {
  it("keeps live stock on Shams MIS", () => {
    expect(catalog).toContain('shamsFetch<RawStockResponse>("/api/v2/product/stock"');
    expect(catalog).toContain("const STOCK_TTL_MS = 60_000;");
    expect(functions).toContain("const { getProductWithStock } = await import");
    expect(stockTab).toContain("const stock = useMemo(() => result?.stock ?? [], [result]);");
  });

  it("never routes stock through the CRM", () => {
    // The CRM's own `available_qty` is read server-side as the denominator for
    // offer scope, consumed there and dropped. It is not a field on anything
    // the browser receives.
    expect(stockTab).not.toContain("shams-crm/products");
    expect(offersServer).toContain("MIS `product/stock` is the stock");
  });

  it("keeps product discovery on the local catalogue", () => {
    expect(catalog).toContain("fetchCatalogCandidates(candidateQuery(q, fragments)");
    expect(catalog).not.toContain('from "@/lib/shams-crm/products.server"');
  });

  it("keeps one branch directory", () => {
    // Branch Stock resolves its labels through `useBranchLabels`, the same read
    // the invoice picker and the order panel use. No second list of cities or
    // districts exists for this page.
    expect(stockTab).toContain("const { data: branchLabels } = useBranchLabels();");
    expect(stockTab.match(/useBranchLabels\(\)/g)).toHaveLength(1);
  });
});
