/**
 * What Branch Stock must answer, and where it may not go to answer it.
 *
 * Nothing here renders — this suite is `environment: "node"` like the rest, and
 * the page's pure rules live in `lib/shams/search.ts` and
 * `lib/shams-crm/offer-summary.ts`, where they are tested directly. What is
 * asserted here is **wiring**: joins between a hook, a server function and a
 * cell that the type checker cannot see and that a plausible-looking edit could
 * quietly undo.
 *
 * The load-bearing claim of this phase is a negative one, so it is asserted as
 * one: **no path from Branch Stock reaches Shams CRM for an offer.** Offers are
 * read from MilaPortal's own tables, filled hours earlier by a background sweep.
 * Live stock still goes to Shams Portal/MIS, because a quantity goes out of date
 * in seconds and nothing else on the page does.
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
const offerStore = read("../../../lib/shams/offer-store.server.ts");
const offerSync = read("../../../lib/shams-crm/offer-sync.server.ts");
const offersServer = read("../../../lib/shams-crm/offers.server.ts");
const migration = read("../../../../supabase/migrations/20260916120000_shams_offers.sql");

/**
 * The migration with its prose removed.
 *
 * Several assertions below are of the form "this column does not exist", and the
 * file explains at length *why* it does not — so a naive substring search finds
 * the explanation and fails. Stripping block and line comments leaves the DDL,
 * which is what those assertions are actually about.
 */
const migrationDdl = migration
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const adminPage = read("../../../routes/_app.admin.shams-sync.tsx");

const SECTION = "/* -------------------------------------------------------------------------- */";

/** The `ProductSummaryCard` body, so a match cannot come from the table below. */
const summaryCard = stockTab.slice(
  stockTab.indexOf("function ProductSummaryCard({"),
  stockTab.indexOf("function Figure({"),
);

/** Everything the tab renders once a product is open. */
const openedProduct = stockTab.slice(
  stockTab.indexOf("      <ProductSummaryCard"),
  stockTab.indexOf(`${SECTION}\n/* Offers, rendered`),
);

/** The result list. */
const resultList = stockTab.slice(
  stockTab.indexOf("const ProductResults = memo("),
  stockTab.indexOf(`${SECTION}\n/* The summary card`),
);

/** The desktop register plus its narrow twin. */
const table = stockTab.slice(stockTab.indexOf("const BranchStockTable = memo("));

/* -------------------------------------------------------------------------- */
/* The critical path                                                           */
/* -------------------------------------------------------------------------- */

describe("Branch Stock never asks Shams CRM for an offer", () => {
  it("reads offers from the local tables in both server functions", () => {
    const productOffers = functions.slice(
      functions.indexOf("export const shamsGetProductOffers"),
      functions.indexOf("export interface ShamsOfferSummariesResult"),
    );
    const summaries = functions.slice(
      functions.indexOf("export const shamsGetOfferSummaries"),
      functions.indexOf("/* Local offer dataset — health and sweep"),
    );

    for (const fn of [productOffers, summaries]) {
      expect(fn).toContain('await import("@/lib/shams/offer-store.server")');
      // The two module paths that would put the CRM back on the critical path.
      expect(fn).not.toContain("shams-crm/offers.server");
      expect(fn).not.toContain("shams-crm/client.server");
    }
  });

  it("leaves the CRM offer read reachable only from the sweep", () => {
    /*
     * `fetchOfferReadNow` is the one function that still contacts
     * `available-branches`. It is called from the background sweep and from
     * nowhere else — the regression this catches is somebody wiring it back
     * into a page for a "fresher" number.
     */
    expect(offerSync).toContain('await import("./offers.server")');
    expect(offerSync).toContain("fetchOfferReadNow(code)");
    expect(stockTab).not.toContain("fetchOfferReadNow");
    expect(hook).not.toContain("fetchOfferReadNow");
    expect(functions).not.toContain("fetchOfferReadNow");
  });

  it("keeps the prefetch workaround deleted rather than replaced by hover", () => {
    /*
     * The previous phase primed the offer query on the click so a ~62 KB CRM
     * request could overlap the router navigation. There is no CRM request left
     * to overlap, so the workaround is gone — and hover prefetching, which was
     * never added, must not arrive as a substitute for the real integration.
     */
    expect(hook).not.toContain("usePrefetchProductOffers");
    expect(hook).not.toContain("prefetchQuery");
    expect(stockTab).not.toContain("prefetchOffers");
    expect(stockTab).not.toMatch(/onMouseEnter=\{[^}]*prefetch/i);
  });

  it("adds no polling anywhere on the page", () => {
    for (const source of [stockTab, hook]) {
      expect(source).not.toContain("refetchInterval");
      expect(source).not.toContain("refetchIntervalInBackground");
      expect(source).not.toContain("setInterval");
    }
    expect(hook).toContain("refetchOnWindowFocus: false,");
  });

  it("asks for the opened product's offers exactly once", () => {
    // The card and the table read the same query — a second observer would be a
    // second round trip for an answer the page already has.
    expect(stockTab.match(/useProductOffers\(/g)).toHaveLength(1);
    expect(stockTab).toContain("const offersQuery = useProductOffers(selected?.itemCode ?? null);");
  });

  it("asks for a whole result set in one call, not one per row", () => {
    expect(stockTab.match(/useOfferSummaries\(/g)).toHaveLength(1);
    expect(stockTab).toContain("useOfferSummaries(resultCodes, !selected)");
  });

  it("has no per-item cap left, because there is no per-item cost", () => {
    /*
     * `MAX_OFFER_SCOPE_ITEMS = 12` was the load-bearing number of the previous
     * design: each item was its own ~62 KB CRM request, so a hundred-row result
     * would have been a hundred of them and the list said "offers not checked".
     * One indexed read answers for the whole set now, which is what lets every
     * search row carry its own discounted price.
     */
    expect(hook).not.toContain("MAX_OFFER_SCOPE_ITEMS");
    expect(stockTab).not.toContain("Offers not checked");
    expect(offerStore).toContain("export const MAX_OFFER_LOOKUP_ITEMS = 200;");
  });
});

/* -------------------------------------------------------------------------- */
/* Live stock is unchanged                                                     */
/* -------------------------------------------------------------------------- */

describe("MIS remains the sole live-stock source", () => {
  it("still reads branch quantities from Shams Portal/MIS", () => {
    expect(catalog).toContain('shamsFetch<RawStockResponse>("/api/v2/product/stock"');
    expect(catalog).toContain("const STOCK_TTL_MS = 60_000;");
    expect(functions).toContain("const { getProductWithStock } = await import");
    expect(stockTab).toContain("const stock = useMemo(() => result?.stock ?? [], [result]);");
  });

  it("reads the quantity on a row from the MIS row and nothing else", () => {
    expect(table).toContain('{out ? "0" : row.quantity}');
    expect(stockTab).not.toContain("available_qty");
    expect(stockTab).not.toContain("availableQty");
  });

  it("keeps CRM availability out of the local dataset entirely", () => {
    /*
     * `available_qty` is read during the sweep to classify coverage — the
     * response lists every branch in the chain, so row count would answer the
     * wrong question — and is dropped there. Only the two derived branch counts
     * are persisted, and no column in the schema could be mistaken for a stock
     * figure.
     */
    expect(offersServer).toContain("const availableQty = num(row?.available_qty);");
    // Read at the boundary, dropped there. No column holds it, and no column
    // holds a quantity of any kind.
    expect(migrationDdl).not.toContain("available_qty");
    expect(migrationDdl).not.toMatch(/\bquantity\b/);
    expect(offerStore).not.toContain("available_qty");
  });

  it("counts available branches from the live stock rows", () => {
    expect(openedProduct).toContain("availableBranches={totalSummary.withStock}");
    // `withStock` counts rows with a positive quantity, from the authoritative
    // stock flow — not rows returned, which is every branch in the chain.
    expect(search).toContain("if (row.quantity > 0) {");
  });
});

/* -------------------------------------------------------------------------- */
/* The search result — the screenshot this phase was opened against            */
/* -------------------------------------------------------------------------- */

describe("a search result shows what the product costs today", () => {
  it("puts the normal price on every row", () => {
    expect(resultList).toContain("<PriceStack listPrice={p.retailPrice} summary={summary} />");
    expect(stockTab).toContain(
      'return <span className="text-sm font-semibold tabular-nums">{fmtSAR(listPrice)}</span>;',
    );
  });

  it("puts the offer badge on a row that has one", () => {
    expect(resultList).toContain("<OfferBadge summary={summary} />");
    expect(stockTab).toContain('{all ? "· all branches" : "· some branches"}');
  });

  it("puts the resulting offer price on the row, beneath the struck-through list price", () => {
    // The agent must not have to open a product to discover the discount.
    expect(stockTab).toContain("{fmtSAR(summary.unitPrice)}");
    expect(stockTab).toContain("{fmtSAR(summary.offerPrice)}");
    expect(stockTab).toContain("line-through");
  });

  it("shows a plain price and no badge when there is no offer", () => {
    // `hasProductOfferPrice` is the gate, and `OfferBadge` renders nothing for
    // `none` — so a product without a promotion gets its price and no empty
    // chrome beside it.
    expect(stockTab).toContain("if (!hasProductOfferPrice(summary)) {");
    expect(stockTab).toContain(
      'if (!summary || summary.scope === "none" || summary.scope === "unknown") return null;',
    );
  });

  /**
   * The correctness rule of the whole feature. A branch-specific promotion has
   * no single price to quote, so the row shows the catalogue price and the
   * badge says "some branches" — the per-branch figures are in the table.
   */
  it("never turns a branch-specific offer into a global product price", () => {
    const summaryModule = read("../../../lib/shams-crm/offer-summary.ts");
    expect(summaryModule).toContain('if (scope.kind !== "all" || offers.length === 0');
    expect(summaryModule).toContain(
      "const unitPrice = unanimous(offers.map((offer) => offer.price));",
    );
    expect(summaryModule).toContain("if (unitPrice === null || offerPrice === null) {");
    // The UI asks the pure predicate rather than re-deriving the rule.
    expect(stockTab).toContain("hasProductOfferPrice(summary)");
  });

  it("says when the dataset cannot answer, rather than showing blanks", () => {
    expect(resultList).toContain("Offer data unavailable");
    expect(resultList).toContain("Offer data not synced yet");
  });
});

/* -------------------------------------------------------------------------- */
/* The top card                                                                */
/* -------------------------------------------------------------------------- */

describe("the product card", () => {
  it("names the product and its code", () => {
    expect(summaryCard).toContain("{product.itemName}");
    expect(summaryCard).toContain("{product.itemCode}");
  });

  it("shows the normal price", () => {
    expect(summaryCard).toContain('<Figure label="Price">');
    expect(summaryCard).toContain("{fmtSAR(product.retailPrice)}");
  });

  it("shows the price without waiting for any request", () => {
    // `retailPrice` travels on the search row the agent clicked — and, for a
    // restored `?item=`, on the detail the route already loaded.
    expect(summaryCard).not.toContain("stockQuery");
    expect(summaryCard).not.toContain("offersQuery");
  });

  it("shows the applied offer and the final price as their own figures", () => {
    expect(summaryCard).toContain('<Figure label="Applied offer">');
    expect(summaryCard).toContain('<Figure label="Offer price">');
    expect(summaryCard).toContain("<AppliedOffer summary={summary} state={offerState} />");
    expect(summaryCard).toContain("{fmtSAR(summary.offerPrice)}");
  });

  it("withholds the final price when no single figure is defensible", () => {
    expect(summaryCard).toContain("hasProductOfferPrice(summary) ? (");
  });

  it("shows units and available branches, and no other branch total", () => {
    expect(summaryCard).toContain('<Figure label="Units in stock">');
    expect(summaryCard).toContain('<Figure label="Available branches">');
    // The chain's branch count is not a fact about this product. An agent asked
    // "where can I get it" wants the number of places that have it.
    expect(summaryCard).not.toContain("branchesTotal");
  });

  it("takes its offer from the opened product, and never from a neighbour", () => {
    expect(stockTab).toContain("offersQuery.data?.ok ? offersQuery.data.summary : null");
    expect(stockTab).toContain("listOffers.byItemCode.get(selected.itemCode)");
  });

  it("stays readable while the offer read is in flight", () => {
    expect(stockTab).toContain("Checking…");
    expect(openedProduct).toContain("offerState={offerState}");
  });

  it("never summarises a failed stock read as zero", () => {
    // `summariseStock([])` is a truthful zero about an empty array and a
    // falsehood about the chain. A failed read renders an em dash and the error
    // panel below carries the reason and the Retry.
    expect(stockTab).toContain("const stockState: OfferState = stockQuery.isPending");
    expect(stockTab).toContain('if (state !== "ready") {');
    expect(openedProduct).toContain("stockState={stockState}");
  });

  it("never reports an unswept or unreadable dataset as 'no offer'", () => {
    expect(stockTab).toContain('if (state === "unavailable") {');
    expect(stockTab).toContain('if (state === "notSynced") {');
    expect(stockTab).toContain("Not synced");
    expect(stockTab).toContain("Unavailable");
  });
});

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

describe("the stock table", () => {
  it("carries all seven columns, with Price and Applied Offer adjacent", () => {
    const headers = [...table.matchAll(/>\s*\n\s*([A-Za-z ]+)\n\s*<\/th>/g)].map((m) =>
      m[1].trim(),
    );
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

  /**
   * The alignment guarantee, asserted structurally rather than visually.
   *
   * One `<table>`, `table-fixed`, and a single `<colgroup>` that is the only
   * place any column width is stated. A `<th>` and the `<td>`s below it are the
   * same table column by definition of the element, so no CSS, breakpoint or
   * content length can make them disagree.
   */
  it("states every column width once, in one colgroup shared by header and rows", () => {
    expect(table).toContain("<colgroup>");
    expect(table.match(/<colgroup>/g)).toHaveLength(1);
    expect(table.match(/<col\b/g)).toHaveLength(7);
    expect(table).toContain("table-fixed");

    // No width anywhere else in the table: a `w-` class on a `th` or `td` is
    // exactly how a header and its column start to drift.
    const cells = table.slice(table.indexOf("<thead>"));
    expect(cells).not.toMatch(/<th[^>]*w-\[/);
    expect(cells).not.toMatch(/<td[^>]*w-\[/);
  });

  it("hides no column at any breakpoint the table renders at", () => {
    // The previous table dropped Status below `lg`, which is what let the
    // header and the body disagree about which column was which.
    const head = table.slice(table.indexOf("<thead>"), table.indexOf("</thead>"));
    expect(head).not.toContain("lg:table-cell");
    expect(head).not.toContain("hidden");
  });

  it("corrects nothing with a pixel offset", () => {
    // If the columns need nudging, the grid is wrong. There is nothing left for
    // an offset to correct, so there is no offset.
    expect(table).not.toMatch(/-?(ml|mr|pl|pr|left|right)-\[\d+px\]/);
    expect(table).not.toMatch(/translate-x-\[/);
  });

  it("defines header and cell padding once each", () => {
    expect(stockTab).toContain("const TH_CELL =");
    expect(stockTab).toContain("const TD_CELL =");
  });

  it("maps price and offer to the branch on the row", () => {
    expect(table).toContain("const offer = offers.get(row.branchCode);");
    expect(table).toContain("{money(branchPrice(offer, listPrice))}");
    expect(table).toContain("<OfferCell offer={offer} state={offerState} />");
  });

  it("prices a branch from its own row when the dataset has one", () => {
    expect(stockTab).toContain("return offer ? offer.price : listPrice;");
    expect(openedProduct).toContain("listPrice={selected.retailPrice}");
  });

  it("never derives a discounted price", () => {
    expect(stockTab).toContain("money(offer.afterOfferPrice)");
    expect(stockTab).not.toMatch(/offerPercent\s*[/*]/);
  });

  it("right-aligns every numeric column", () => {
    expect(table).toContain('className={cn(TH_CELL, "text-right")}');
    expect(table).toContain('cn(TD_CELL, "text-right tabular-nums")');
    expect(table).toContain('"text-right font-semibold tabular-nums"');
  });

  it("isolates Arabic so it reads RTL without dragging its cell", () => {
    /*
     * `<bdi>` rather than `dir="auto"` on the cell. `dir="auto"` would flip the
     * whole cell, and a City column that right-aligns for Arabic branches and
     * left-aligns for the rest is precisely the drift this table was rebuilt to
     * remove.
     */
    expect(stockTab).toContain("<bdi className=");
    expect(table).toContain("<Place value={place.city}");
    expect(table).toContain("<Place value={place.district} />");
    expect(table).not.toMatch(/<td[^>]*dir="auto"/);
  });

  it("truncates long names rather than reflowing the row", () => {
    expect(stockTab).toContain("block truncate");
    expect(stockTab).toContain("title={title ?? value}");
  });

  it("switches to a card per branch below md rather than collapsing columns", () => {
    expect(table).toContain("md:hidden");
    expect(table).toContain('<div className="hidden overflow-x-auto md:block">');
    // The scroll is bounded to the table, and `min-w` sits below the `md`
    // breakpoint so at any ordinary width there is nothing to scroll.
    expect(table).toContain("min-w-[44rem]");
    expect(stockTab.match(/overflow-x/g)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* City and district                                                           */
/* -------------------------------------------------------------------------- */

describe("city and district", () => {
  it("reads both off the branches table, in one select", () => {
    expect(hook).toContain('supabase.from("branches").select("branch_no,city,address")');
    expect(hook.match(/from\("branches"\)/g)).toHaveLength(1);
  });

  it("derives the حي with the branch directory's own rule", () => {
    expect(hook).toContain('import { extractDistrict } from "@/features/branches/district";');
    expect(hook).toContain("district: extractDistrict(b.address, b.city),");
  });

  it("keeps one branch directory", () => {
    expect(stockTab).toContain("const { data: branchLabels } = useBranchLabels();");
    expect(stockTab.match(/useBranchLabels\(\)/g)).toHaveLength(1);
    /*
     * The CRM's availability response carries a nested `branch` object with a
     * city, a district, an address and coordinates. None of it is persisted:
     * the offer schema holds a branch **code** and nothing else about a branch,
     * so the directory stays the one place a city comes from.
     */
    expect(migrationDdl).not.toMatch(/\bcity\b/);
    expect(migrationDdl).not.toMatch(/\bdistrict\b/);
  });

  it("keeps the Arabic folding search behaviour", () => {
    expect(search).toContain('import { foldText } from "@/features/branches/normalize";');
    expect(search).toContain("const needle = foldText(query);");
    expect(search).toContain(
      '[row.branchCode, row.city ?? "", row.cityEnglish ?? "", row.district ?? ""].join(" ")',
    );
  });

  it("says what the filter searches without a paragraph of instructions", () => {
    expect(stockTab).toContain("Branch, city or district — P0221 · جدة · حي الحمراء");
    expect(openedProduct).not.toContain("Filter by branch code, English or Arabic city");
  });
});

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

describe("loading, empty and failure", () => {
  it("shows a skeleton only while there is genuinely nothing to show", () => {
    expect(openedProduct).toContain("{stockQuery.isFetching && !result && <TableSkeleton />}");
    const detail = hook.slice(
      hook.indexOf("export function useProductDetail("),
      hook.indexOf("export function useProductOffers("),
    );
    expect(detail).not.toContain("placeholderData");
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
    expect(openedProduct).toContain('{offerState === "notSynced" && (');
    expect(openedProduct).toContain('{offerState === "unavailable" && (');
    expect(openedProduct).toContain("Offer data has not been synced yet");
  });

  it("lets an offer failure leave the stock table exactly as it was", () => {
    // Offers are an enhancement. The tab has no error state for them and never
    // blocks on them; the column empties and a line above says why.
    expect(openedProduct).not.toContain("offersQuery.isError");
  });

  it("has its own failure copy, which does not blame Shams", () => {
    const constants = read("../constants.ts");
    expect(constants).toContain("offers_unavailable:");
    const copy = constants.slice(constants.indexOf("offers_unavailable:"));
    expect(copy.slice(0, 120)).not.toMatch(/Shams/);
  });
});

/* -------------------------------------------------------------------------- */
/* The dataset behind it all                                                   */
/* -------------------------------------------------------------------------- */

describe("the local offer dataset", () => {
  it("distinguishes a checked item with no offer from one nobody has swept", () => {
    /*
     * The single most important property of the schema. `shams_offer_products`
     * holds a row for every item the sweep has *checked*, offer or not, so
     * `scope = 'none'` is a fact with a date on it and a missing row is an
     * absence — and the UI can tell them apart.
     */
    expect(migration).toContain("scope IN ('all', 'some', 'none')");
    expect(migration).toContain("checked_at");
    expect(offerStore).toContain("has not been swept yet");
  });

  it("stores a product-level price pair only as a pair", () => {
    expect(migration).toContain("CONSTRAINT shams_offer_products_price_pair");
    expect(migration).toContain("CHECK ((unit_price IS NULL) = (offer_price IS NULL))");
  });

  it("scopes the promotion to the slice's own item codes", () => {
    /*
     * The difference between this and the catalogue's promotion, and the reason
     * an incremental sweep is safe at all: a slice covering 150 of 8,484
     * products must not delete the other 8,334.
     */
    expect(migration).toContain("WITH covered AS (");
    expect(migration).toContain("WHERE o.item_code IN (SELECT item_code FROM covered)");
  });

  it("refuses to promote a slice that covered nothing", () => {
    // Promoting an empty slice would advance the cursor past products nobody
    // looked at, leaving a hole no later run revisits.
    expect(migration).toContain("shams_promote_offers: refused -- the batch covered no items");
    expect(offerStore).toContain("The offer sweep produced no items, so nothing was promoted.");
  });

  it("counts rows changed as rows that moved, never rows processed", () => {
    expect(migration).toContain(
      "last_rows_changed    = rows_inserted + rows_updated + rows_deleted + summaries_changed",
    );
    expect(migration).toContain("Rows whose values actually moved: inserted + updated + deleted.");
    // The unchanged-row guard, without which every slice would rewrite rows
    // that had not moved and `source_updated_at` would become a copy of the
    // sweep time.
    expect(migration).toContain("WHERE o.price             IS DISTINCT FROM EXCLUDED.price");
  });

  it("reuses the catalogue's staging and promotion shape rather than inventing one", () => {
    for (const marker of [
      "shams_offers_staging",
      "shams_offer_products_staging",
      "shams_offer_sync_state",
      "next_refresh_due_at",
      "last_attempt_at",
      "last_success_at",
      "last_outcome",
      "last_error",
      "source_marker",
    ]) {
      expect(migration).toContain(marker);
    }
    expect(offerStore).toContain("export async function beginOfferAttempt(");
    expect(offerStore).toContain("export async function recordOfferAttempt(");
  });

  it("rides the existing scheduler tick rather than adding a second one", () => {
    const scheduler = read("../../../lib/shams-crm/sync-scheduler.server.ts");
    expect(scheduler).toContain('await import("./offer-sync.server")');
    expect(scheduler).toContain("if (await isOfferSweepDue(supabase, now))");
    expect(migration).toContain("SELECT count(*) INTO offers_due");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.shams_sync_tick()");
  });

  it("never fires the CRM's own promotions job", () => {
    // `POST /promotions/sync` starts a ~24-minute job on Shams' infrastructure.
    for (const source of [offerSync, offerStore, functions, stockTab, hook]) {
      expect(source).not.toContain('"/promotions/sync"');
    }
    expect(offerSync).toContain('"/promotions/sync/status"');
  });
});

/* -------------------------------------------------------------------------- */
/* Admin visibility                                                            */
/* -------------------------------------------------------------------------- */

describe("Sync Control", () => {
  it("shows offers beside the catalogue, in the same shell", () => {
    expect(adminPage).toContain("function OffersPanel()");
    expect(adminPage).toContain("<OffersPanel />");
    expect(adminPage).toContain("<CatalogPanel />");
    // The same primitives the catalogue panel uses — not a screen of its own.
    expect(adminPage).toContain("<AdminSection");
    expect(adminPage).toContain("<HealthIndicator");
    expect(adminPage).toContain('<DataRow label="Products checked">');
  });

  it("exposes the metrics an operator has to be able to read", () => {
    for (const label of [
      "Products checked",
      "Products on offer",
      "Branch offer rows",
      "Last full sweep",
      "Last outcome",
      "Next check",
      "Last slice — processed",
      "Last slice — rows changed",
      "Inserted",
      "Updated",
      "Removed",
    ]) {
      expect(adminPage).toContain(label);
    }
  });

  it("gives the manual control the same permission model as the catalogue's", () => {
    const sweep = functions.slice(functions.indexOf("export const shamsOfferSweepNow"));
    // `assertAdmin`, and audited before the attempt — exactly what
    // `shamsCatalogRefreshNow` does, and for the same reason.
    expect(sweep).toContain("await assertAdmin(supabase, userId);");
    expect(sweep).toContain("AUDIT_ACTIONS.shamsOffersSwept");
    // The health read is the wider gate, because it spends nothing.
    expect(functions).toContain('await assertPermission(supabase, userId, "view_shams_mis");');
  });
});
