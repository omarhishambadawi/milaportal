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

const customersTab = readFileSync(
  fileURLToPath(new URL("../components/customers-tab.tsx", import.meta.url)),
  "utf8",
);

const search = readFileSync(
  fileURLToPath(new URL("../../../lib/shams/search.ts", import.meta.url)),
  "utf8",
);

const catalog = readFileSync(
  fileURLToPath(new URL("../../../lib/shams/catalog.server.ts", import.meta.url)),
  "utf8",
);

describe("an item code is still findable, now from the local catalogue", () => {
  /*
   * The capability from e876452 is preserved through a second move of its
   * mechanism. Discovery left the MIS for the CRM catalogue, and has now left
   * the CRM for MilaPortal's own table — but an agent pasting a code has always
   * been able to find the product, and always without a second MIS request.
   *
   * The rule itself now lives in `search.ts` beside the wildcard rules, so that
   * the SQL retrieval and the in-process match are written against one statement
   * of what a match is.
   */
  it("matches an exact item code", () => {
    expect(search).toContain("if (product.itemCode === q) return true;");
  });

  it("matches the first digits of a code, which no previous source could retrieve", () => {
    expect(search).toContain("looksLikeItemCode(q) && product.itemCode.startsWith(q)");
  });

  it("searches the name too, so the field is never told which kind was typed", () => {
    expect(search).toContain("normalizeForSearch(product.itemName).includes(needle)");
    expect(catalog).toContain("matchesProductQuery(product, q)");
  });

  it("no longer spends a product/info request to answer a code", () => {
    expect(catalog).not.toContain("getProductDetail(q).catch");
  });

  it("asks neither the MIS nor Shams CRM for product discovery", () => {
    expect(catalog).not.toContain('"/api/v2/product/search"');
    /*
     * The CRM download is what made a cold worker slow, and the import is what
     * proves it is gone — the name still appears in a comment explaining why,
     * which is worth keeping and is not a call.
     */
    expect(catalog).not.toContain('from "@/lib/shams-crm/products.server"');
    expect(catalog).toContain("fetchCatalogCandidates(");
  });

  it("retrieves candidates with escaped LIKE patterns, never raw agent text", () => {
    // `%` and `_` in a query are literal characters in this search's grammar and
    // syntax in Postgres'. Escaping is the only thing keeping the two agreed.
    expect(catalog).toContain("escapeLikePattern");
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

  it("matches offers to branch rows by branch code", () => {
    expect(stockTab).toContain("offers.get(row.branchCode)");
  });

  it("shows an offer only on the branch that actually has one", () => {
    // The rule has outlived two layouts — a conditional column, then a card
    // footer, now a table cell. A branch with no promotion renders no offer at
    // all, and the cell is left blank rather than filled with a dash that would
    // read as data.
    expect(stockTab).toContain("{offer ? <OfferPrice offer={offer} /> : null}");
    expect(stockTab).toContain("{offer && <OfferPrice offer={offer} />}");
  });

  it("keeps the branch view a table rather than a surface per branch", () => {
    // ~140 branches is a register, not a gallery: one table with fixed columns,
    // and a dense list below `md` instead of a sideways-scrolling table.
    expect(stockTab).toContain("const BranchStockTable = memo(");
    expect(stockTab).toContain("<BranchStockTable rows={visible}");
    expect(stockTab).not.toContain("BranchStockCards");
    expect(stockTab).toContain("md:hidden");
    // No `overflow-x` anywhere in the branch view — the page must never scroll
    // sideways, and neither must the table region.
    expect(stockTab).not.toContain("overflow-x");
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
    // The tab is validated against the known set rather than a two-way
    // conditional, so adding a tab cannot silently make it unreachable by URL.
    expect(shamsRoute).toContain("TAB_IDS.includes(s.tab as TabId)");
    expect(shamsRoute).toContain('q: typeof s.q === "string"');
    expect(shamsRoute).toContain('item: typeof s.item === "string"');
  });

  it("carries a handed-over document as identifiers, never as a person", () => {
    // A document number and a warehouse code may live in the address bar. The
    // mobile number that found them may not — the Customers tab keeps its
    // search in local state for exactly that reason.
    expect(shamsRoute).toContain('doc: typeof s.doc === "string" && DOC_NO.test(s.doc.trim())');
    expect(shamsRoute).toContain(
      'typeof s.branch === "string" && BRANCH_CODE.test(s.branch.trim())',
    );
    expect(shamsRoute).not.toContain("s.mobile");
    expect(customersTab).not.toContain("useNavigate");
    expect(customersTab).not.toContain("navigate({");
  });

  it("pushes when a product is opened, so Back returns to the results", () => {
    expect(shamsRoute).toContain("put({ item: product?.itemCode }, false)");
  });

  it("pushes when an invoice is opened from a history, so Back returns to it", () => {
    expect(shamsRoute).toContain('put({ tab: "invoices", doc: docNo, branch: branchCode }, false)');
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

/* -------------------------------------------------------------------------- */

/**
 * Customer enrichment must not become the page's next N+1.
 *
 * The failure mode is specific and easy to reintroduce: an invoice view that
 * "just looks the customer up" turns a page of results into one CRM request per
 * row — each one a lookup of identifiable data. The design forecloses it by
 * having no invoice → customer request at all, and these assertions are what
 * hold that shape in place.
 */
describe("enrichment costs no extra requests", () => {
  it("makes exactly one CRM request per submitted search", () => {
    // One hook, one page. Not `useQueries`, not a call inside a map.
    expect(customersTab.match(/useCustomerHistory\(/g)).toHaveLength(1);
    expect(customersTab).not.toContain("useQueries");
  });

  it("never asks the CRM from the Invoices tab", () => {
    // The invoice view reads a link the CRM search already established; it has
    // no route to the endpoint itself.
    expect(source).not.toContain("useCustomerHistory");
    expect(source).not.toContain("shamsGetCustomerHistory");
    expect(source).toContain("recallInvoiceCustomer(invoice.branchCode, invoice.docNo)");
  });

  it("only the CRM history writes a customer link", () => {
    // `rememberInvoiceCustomer` is called with the customer from the same
    // response that named the document. Nothing derives one from an invoice.
    expect(customersTab).toContain(
      "rememberInvoiceCustomer(sale.branchCode, sale.docNo, customer)",
    );
    expect(source).not.toContain("rememberInvoiceCustomer");
  });

  it("opens a handed-over document at its branch, so no sweep runs", () => {
    // The handoff carries the branch, which is what makes it one request
    // instead of 137 — the same fast path a manually named branch takes.
    expect(source).toContain("setSubmittedBranch(handoffBranch)");
    expect(source).toContain("setBranchCode(handoffBranch)");
  });
});

/**
 * A search must never render the previous customer.
 *
 * `placeholderData` exists so paging does not blank the table. The bug it can
 * quietly introduce is worse than the flicker it fixes: carried across a change
 * of *number*, it shows one person's name, mobile and purchases under the number
 * an agent just typed for someone else.
 */
describe("customer results never outlive their search", () => {
  it("keeps the previous page only when the search itself is unchanged", () => {
    expect(hook).toContain("placeholderData: (previous, previousQuery) =>");
    // Everything but the page index has to match before rows are reused.
    expect(hook).toContain("before[2] === now[2]");
    expect(hook).toContain("before[6] === now[6]");
    expect(hook).toContain("return sameSearch ? previous : undefined;");
  });

  it("does not carry data across every key change", () => {
    /*
     * Scoped to `useCustomerHistory`, deliberately. Product search *does* carry
     * its previous result set across a term change, and should: a list of
     * products belongs to nobody, so showing last moment's while this moment's
     * loads cannot put one person's data under another person's name. A file-wide
     * assertion would forbid the safe case to protect the dangerous one.
     */
    const historyHook = hook.slice(hook.indexOf("export function useCustomerHistory"));

    expect(historyHook).not.toContain("placeholderData: (previous) => previous");
    expect(historyHook).not.toContain("keepPreviousData");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Switching tabs must not throw away what a tab already loaded.
 *
 * Radix unmounts an inactive tab by default, and unmounting was the whole
 * problem: it discarded every `useState` in the tab — the typed search, the
 * chosen branch, the page — and every React Query observer with it, so coming
 * back remounted and refetched from zero. `forceMount` is the fix, and these
 * assertions are what keep it.
 *
 * The autoFocus rule is the cost of that fix and belongs in the same place:
 * three tabs mounting at once means three inputs can claim focus, and the one
 * that wins may be on a tab nobody can see.
 */
describe("tab state survives a switch", () => {
  it("keeps all three tabs mounted", () => {
    // Counted on the elements, not in prose: the comment above them uses the
    // word too.
    const mounted = shamsRoute.match(/<TabsContent[\s\S]{0,120}?forceMount/g) ?? [];
    expect(mounted).toHaveLength(3);
    // Hidden rather than unmounted, so nothing is visible from an inactive tab.
    expect(shamsRoute).toContain("data-[state=inactive]:hidden");
  });

  it("tells each tab whether it is the visible one", () => {
    expect(shamsRoute).toContain('active={tab === "stock"}');
    expect(shamsRoute).toContain('active={tab === "invoices"}');
    expect(shamsRoute).toContain('active={tab === "customers"}');
  });

  it("focuses only the visible tab's input", () => {
    // Unconditional `autoFocus` would hand focus to whichever of the three
    // mounted last.
    expect(source).toContain("autoFocus={active}");
    expect(stockTab).toContain("autoFocus={active}");
    expect(customersTab).toContain("autoFocus={active}");
    expect(stockTab).not.toMatch(/autoFocus\s*\n\s*\/>/);
  });

  it("does not buy preservation by disabling refetching", () => {
    // The queries keep their own staleness rules; only the remount is gone.
    expect(hook).not.toContain("refetchOnMount: false");
    expect(hook).not.toContain("staleTime: Infinity");
  });

  it("still asks for nothing until a search is made", () => {
    // Three tabs mounting at once must not become three requests on page load.
    expect(hook).toContain("enabled: enabled && searchable");
    expect(hook).toContain("enabled: Boolean(query)");
    expect(hook).toContain("enabled: enabled && Boolean(lookup?.branchCode && lookup?.docNo)");
  });
});

/**
 * Change product: one click, one change.
 *
 * The bug was a race, not a missing handler. Clearing `stockProduct` on the
 * click made `restoring` true — the URL still carried `?item=` for a tick — so
 * the restore effect refetched the product from cache and put it straight back.
 * The second click only worked because the URL had caught up by then.
 */
describe("change product takes one click", () => {
  it("does not clear the local product on deselect", () => {
    // `if (product)` is the fix: a deselect is a URL change and nothing else,
    // so state and URL never disagree and the restore effect stays quiet.
    expect(shamsRoute).toContain("if (product) setStockProduct(product);");
    // The unguarded assignment is what reinstated the product on the first
    // click, and clearing it explicitly is the same bug written differently.
    expect(shamsRoute).not.toMatch(/^\s*setStockProduct\(product\);$/m);
    expect(shamsRoute).not.toContain("setStockProduct(null)");
  });

  it("renders the open product only when the URL agrees", () => {
    expect(shamsRoute).toContain(
      "const openProduct = item && stockProduct?.itemCode === item ? stockProduct : null;",
    );
    expect(shamsRoute).toContain("selected={openProduct}");
  });

  it("still clears the selection through the URL", () => {
    expect(shamsRoute).toContain("put({ item: product?.itemCode }, false)");
  });
});

/**
 * Offers on the result list, without turning a search into a hundred requests.
 */
describe("offer badges are bounded", () => {
  it("asks for a whole result set in one call, not one call per row", () => {
    expect(stockTab).toContain("useOfferScopes(resultCodes, !selected)");
    expect(stockTab.match(/useOfferScopes\(/g)).toHaveLength(1);
  });

  it("stops asking once a product is open", () => {
    // The result list is gone but its query data is still cached, so without
    // the `!selected` gate the tab would keep checking a list nobody sees.
    expect(stockTab).toContain("!selected");
  });

  it("says when a set was too large to check, rather than showing blanks", () => {
    // A row with no badge would otherwise read as "no offer", which is a claim
    // nobody made.
    expect(stockTab).toContain("offersSkipped");
    expect(stockTab).toContain("Offers not checked");
  });

  it("distinguishes all branches from some branches in the label", () => {
    expect(stockTab).toContain("· all branches");
    expect(stockTab).toContain("· some branches");
  });

  it("renders nothing for an item with no offer and for one not checked", () => {
    expect(stockTab).toContain(
      'if (!scope || scope.kind === "none" || scope.kind === "unknown") return null;',
    );
  });

  it("reuses the opened product's own response rather than asking again", () => {
    expect(stockTab).toContain("offersQuery.data.scope");
  });
});
