/**
 * How the Invoices tab decides what to ask the MIS.
 *
 * The expensive thing on this page is the branch sweep: the MIS cannot look a
 * document up across warehouses, so finding one by number alone means asking
 * every branch — 141 of the 144 rows in `branches` carry a sweepable code — in
 * four parallel parts at 24 in flight. Naming the branch makes that exactly one
 * request instead.
 *
 * Nothing here renders. What is asserted is the wiring that decides between the
 * two paths, because it is invisible to the type checker and a plausible-looking
 * edit could quietly reinstate the sweep for every search.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../components/invoices-tab.tsx", import.meta.url)),
  "utf8",
);

const hook = readFileSync(
  fileURLToPath(new URL("../hooks/use-shams-data.ts", import.meta.url)),
  "utf8",
);

describe("naming a branch skips the sweep", () => {
  it("disables discovery when the search carried a branch", () => {
    // The whole optimisation, in one argument.
    expect(source).toContain("useInvoiceBranches(submitted, !submittedBranch)");
  });

  it("gates every part of the sweep on that flag, not just the first", () => {
    // Four queries run in parallel; one ungated part would still probe a
    // quarter of the chain.
    expect(hook).toContain("const active = enabled && Boolean(docNo);");
    expect(hook).toMatch(
      /queries: Array\.from\(\{ length: DISCOVERY_PARTS \}[\s\S]*?enabled: active,/,
    );
  });

  it("sends the chosen branch straight to the document lookup", () => {
    expect(source).toContain("setBranchCode(branchFilter);");
    expect(source).toContain("useInvoiceLookup(");
  });
});

describe("the branch filter is optional", () => {
  it("starts unset, so a bare number still searches everywhere", () => {
    expect(source).toContain("useState<string | null>(null)");
    expect(source).toContain("All branches");
  });

  it("can be cleared back to every branch", () => {
    expect(source).toContain('aria-label="Clear branch filter"');
    expect(source).toContain("onChange(null)");
  });

  it("does not gate submission on a branch being chosen", () => {
    // `canSubmit` is about the number and nothing else.
    expect(source).toContain('const canSubmit = docNo.trim() !== "";');
  });

  it("re-reads the filter only on submit, not as it changes", () => {
    // Otherwise changing the picker would silently re-scope results already on
    // screen without re-running the search behind them.
    expect(source).toContain("setSubmittedBranch(branchFilter);");
  });
});

describe("the branch pickers search the same two things", () => {
  it("offers code and city in the selector", () => {
    expect(source).toContain('value={`${b.branchNo} ${b.city} ${b.cityEnglish ?? ""}`}');
    expect(source).toContain('placeholder="Search a branch code or city…"');
  });

  it("filters the returned matches without another request", () => {
    // Narrowing a list already in hand: no refetch, no new sweep.
    expect(source).toContain("const shown = useMemo(");
    expect(source).toContain("matches.filter(");
  });

  it("only offers that filter once the list is long enough to need it", () => {
    expect(source).toContain("const FILTERABLE_FROM = 6;");
    expect(source).toContain("matches.length >= FILTERABLE_FROM");
  });
});

describe("nothing is fetched before a search", () => {
  it("has no invoice query outside a submitted number", () => {
    // The tab opens on an empty state. There is no list to preload and no
    // invoices table to page through — invoices live in the MIS, and the only
    // reads are the two lookups a submission triggers.
    expect(source).toContain("Enter an invoice number to look it up across all Shams branches.");
    expect(source).not.toContain("useQuery({");
  });
});

/* -------------------------------------------------------------------------- */
/* Product search: item codes, and state that survives Back                    */
/* -------------------------------------------------------------------------- */

const stockTab = readFileSync(
  fileURLToPath(new URL("../components/stock-tab.tsx", import.meta.url)),
  "utf8",
);

const shamsRoute = readFileSync(
  fileURLToPath(new URL("../../../routes/_app.shams.tsx", import.meta.url)),
  "utf8",
);

const catalog = readFileSync(
  fileURLToPath(new URL("../../../lib/shams/catalog.server.ts", import.meta.url)),
  "utf8",
);

describe("an item code is still findable, now from the catalog", () => {
  // The capability from e876452 is preserved; only its mechanism moved. Product
  // discovery is the CRM catalog's job since Phase 4, so an exact code is a scan
  // of rows already in hand rather than a second MIS request.
  it("matches an exact item code against the catalog rows", () => {
    expect(catalog).toContain("product.itemCode === q");
  });

  it("searches the name too, so the field is never told which kind was typed", () => {
    expect(catalog).toContain("normalizeForSearch(product.itemName).includes(needle)");
  });

  it("no longer spends a product/info request to answer a code", () => {
    expect(catalog).not.toContain("looksLikeItemCode(q)");
    expect(catalog).not.toContain("getProductDetail(q).catch");
  });

  it("does not ask the MIS for product discovery at all", () => {
    expect(catalog).not.toContain('"/api/v2/product/search"');
    expect(catalog).toContain("getCrmProducts()");
  });
});

describe("MIS keeps the operational reads", () => {
  // Only discovery moved. Stock, availability and product detail are still the
  // MIS's, and a product found in the CRM catalog is looked up there by code.
  it("still reads product detail and branch stock from the MIS", () => {
    expect(catalog).toContain('shamsFetch<RawProductInfoResponse>("/api/v2/product/info"');
    expect(catalog).toContain('shamsFetch<RawStockResponse>("/api/v2/product/stock"');
  });

  it("keeps the batched stock read the invoice flow depends on", () => {
    expect(catalog).toContain("export async function getStockForItems(");
    expect(catalog).toContain("export async function getProductWithStock(");
  });
});

describe("CRM offer pricing sits beside MIS stock, never on top of it", () => {
  it("loads offers as their own query, not inside the stock read", () => {
    // Independent, so a slow or unhappy CRM cannot delay the stock table.
    expect(stockTab).toContain("useProductOffers(selected?.itemCode ?? null)");
    expect(stockTab).toContain("useProductDetail(");
  });

  it("treats an offer failure as no offers rather than an error state", () => {
    expect(stockTab).toContain("offersQuery.data?.ok ? offersQuery.data.offers : []");
  });

  it("matches offers to stock rows by branch code", () => {
    expect(stockTab).toContain("offers.get(row.branchCode)");
    expect(stockTab).toContain("offers.has(row.branchCode)");
  });

  it("shows the Offer column only when a row actually has one", () => {
    expect(stockTab).toContain("const anyOffer = rows.some((row) => offers.has(row.branchCode))");
    expect(stockTab).toContain("{anyOffer &&");
  });

  it("renders the API's after-offer price rather than deriving one", () => {
    expect(stockTab).toContain("fmtSAR(offer.afterOfferPrice)");
    expect(stockTab).toContain("offer.offerDisplay");
    // No arithmetic on the discount anywhere in the view.
    expect(stockTab).not.toMatch(/offerPercent\s*[/*]/);
  });

  it("still renders quantity from the MIS row", () => {
    // The stock number is `row.quantity` — an MIS field. CRM availability is not
    // mapped at all, so it cannot reach this table.
    expect(stockTab).toContain('{out ? "0" : row.quantity}');
    expect(stockTab).not.toContain("available_qty");
    expect(stockTab).not.toContain("availableQty");
  });
});

describe("the search survives Back", () => {
  it("keeps the query, the tab and the open product in the URL", () => {
    expect(shamsRoute).toContain("validateSearch:");
    expect(shamsRoute).toContain('tab: s.tab === "invoices" ? "invoices" : "stock"');
    expect(shamsRoute).toContain('q: typeof s.q === "string"');
    expect(shamsRoute).toContain('item: typeof s.item === "string"');
  });

  it("pushes when a product is opened, so Back returns to the results", () => {
    expect(shamsRoute).toContain("put({ item: product?.itemCode }, false)");
  });

  it("replaces while typing, so Back is not a walk through every keystroke", () => {
    expect(shamsRoute).toContain("put({ q: next || undefined }, true)");
    expect(shamsRoute).toContain("put({ tab: v as TabId }, true)");
  });

  it("restores the open product from its code alone", () => {
    // Back arrives with `?item=` and nothing in hand.
    expect(shamsRoute).toContain("const restoring = Boolean(item)");
    expect(shamsRoute).toContain("useProductDetail(item ?? null, restoring)");
  });

  it("adopts a query that changed underneath the box without fighting typing", () => {
    expect(stockTab).toContain("setDraft((d) => (d === query ? d : query));");
  });

  it("publishes only the settled term, not the keystroke", () => {
    expect(stockTab).toContain("const term = useDebounced(draft);");
    expect(stockTab).toContain("if (term !== query) onQueryChange(term);");
  });
});
