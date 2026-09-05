/**
 * Branch Stock — find a product, then read its availability per branch.
 *
 * This is the whole catalog experience since the standalone Products tab was
 * removed: the same `product/search` lookup starts here, and choosing a result
 * loads the stock the agent came for. One screen, one flow, one request per
 * step.
 *
 * Four decisions worth stating.
 *
 * **The summary card answers the call, not the page.** An agent on the phone is
 * asked four things — what does it cost, is there an offer on it, how many are
 * there, and where. All four are on the card the moment a product opens, and
 * three of them cost **no request at all**: the price travels on the search row
 * the agent clicked, and the offer's coverage was already classified for the
 * result list. Only the per-branch offer prices are still fetched, and the card
 * is readable long before they land. See `ProductSummaryCard`.
 *
 * **No invented thresholds.** The application defines no "low stock" boundary,
 * so none is shown. A branch either has none — a fact, marked destructive
 * because it is the answer an agent is scanning for — or it has a number,
 * rendered as that number.
 *
 * **The branch results are a register, not a gallery.** One product against
 * ~140 branches is operational data read by scanning a column, so it is a dense
 * table with fixed columns and reserved colour. See `BranchStockTable`.
 *
 * **Branch names, cities and districts come from MilaServ.** The MIS returns
 * `branchName` identical to `branchCode` on every row, so it is not a display
 * name. Discovery established that `branchCode` is the same identifier as
 * `branches.branch_no`, so the portal's own directory supplies the Arabic city
 * and the حي — the same directory the Branch Directory page reads, never a
 * second list. A code the portal does not know still renders, with its code
 * alone, rather than being dropped.
 */

import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Boxes, Loader2, PackageX, Search, Tag, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { filterBranchStock, summariseStock } from "@/lib/shams/search";
import type { ShamsBranchStock, ShamsProduct } from "@/lib/shams/types";
import type { ShamsCrmOffer, ShamsOfferScope } from "@/lib/shams-crm/types";
import {
  MAX_OFFER_SCOPE_ITEMS,
  MIN_QUERY_LENGTH,
  useBranchLabels,
  useDebounced,
  useOfferScopes,
  useProductDetail,
  useProductOffers,
  useProductSearch,
  usePrefetchProductOffers,
  type BranchLabel,
} from "@/features/shams/hooks/use-shams-data";
import { TD, TH } from "@/features/shams/constants";
import { EmptyState, ErrorState, NotConfiguredState, TableSkeleton } from "./states";

/**
 * The product search box.
 *
 * Wildcards are advertised in the placeholder rather than hidden behind help
 * text: an agent who knows fragments of a name (`mou*n*j*2.5`) is the case this
 * page is built for, and a syntax nobody discovers is a syntax nobody uses.
 */
export function ProductSearchField({
  value,
  onChange,
  onKeyDown,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Search Shams products"
        autoComplete="off"
        autoFocus={autoFocus}
        className="h-11 pl-9 pr-9 text-base"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function StockTab({
  active = true,
  selected,
  onSelect,
  query,
  onQueryChange,
}: {
  /**
   * Whether this tab is the one on screen.
   *
   * All three tabs are mounted at once so their state and cached data survive a
   * switch, which means `autoFocus` can no longer be unconditional: three
   * inputs claiming focus on one mount would hand it to whichever rendered
   * last, quite possibly one the agent cannot see.
   */
  active?: boolean;
  selected: ShamsProduct | null;
  onSelect: (product: ShamsProduct | null) => void;
  /**
   * The search text, owned by the route so it lives in the URL.
   *
   * Lifted for one reason: an agent who opened a product and pressed Back came
   * back to an empty box and had to type the search again. The box is still
   * typed into locally (`draft`), and only the settled value is published
   * upward, so the address bar does not churn on every keystroke.
   */
  query: string;
  onQueryChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState(query);
  const term = useDebounced(draft);

  // Adopt the query when it changes underneath us — a Back navigation, or a
  // link opened with `?q=`. Guarded on inequality so typing is never fought.
  useEffect(() => {
    setDraft((d) => (d === query ? d : query));
  }, [query]);

  // Publish the settled term upward, so the URL carries what was searched
  // rather than what is being typed.
  useEffect(() => {
    if (term !== query) onQueryChange(term);
    // `onQueryChange` is recreated per render by the route; `term` is what
    // decides this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  // The picker only runs while no product is chosen — once one is, this tab is
  // about its stock, and there is nothing to search for.
  const searchQuery = useProductSearch(term, !selected);

  /** Whether the settled term is long enough for the server to answer at all. */
  const searchable = term.trim().length >= MIN_QUERY_LENGTH;

  /**
   * The rows on screen.
   *
   * `searchable` is load-bearing, not decorative. The search query keeps the
   * previous result set as placeholder data so a new term dims the list instead
   * of collapsing it to a skeleton — but placeholder data survives the query
   * being disabled too, so without this an agent deleting back to one character
   * would keep looking at results for a term they have just erased.
   */
  const matches = useMemo(
    () => (searchable ? (searchQuery.data?.products ?? []) : []),
    [searchQuery.data, searchable],
  );

  /**
   * True while showing an answer that belongs to an earlier term.
   *
   * The list is rendered rather than replaced — losing results mid-typing is
   * worse than briefly showing stale ones — so it says so instead, by dimming.
   */
  const stale = searchQuery.isFetching && searchQuery.isPlaceholderData;

  /** Highlighted row, for arrow-key navigation of the result list. */
  const [activeIndex, setActiveIndex] = useState(0);
  // A new result set invalidates the old highlight; without this, Enter after a
  // re-search picks whatever now sits at a stale index.
  useEffect(() => {
    setActiveIndex(0);
  }, [matches]);

  /**
   * Keyboard control from the search box, so a fast agent never leaves it:
   * ↑ ↓ move, Enter picks the highlighted row, Escape clears the search.
   */
  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setDraft("");
      return;
    }
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = matches[activeIndex] ?? matches[0];
      if (picked) onSelect(picked);
    }
  };

  const stockQuery = useProductDetail(selected?.itemCode ?? null, Boolean(selected));
  const result = stockQuery.data;
  const stock = useMemo(() => result?.stock ?? [], [result]);

  const { data: branchLabels } = useBranchLabels();

  /**
   * CRM offer pricing for this item, loaded alongside the MIS stock rather than
   * after them. A failure here is silent by construction: `offers` is empty and
   * the table renders exactly as it did before offers existed.
   *
   * The request usually left before this hook mounted — `onPick` below primes
   * the same query key on the click, so the CRM read overlaps the navigation
   * instead of waiting for it. Same key, so this is one request, not two.
   */
  const offersQuery = useProductOffers(selected?.itemCode ?? null);
  const offers = useMemo(() => {
    const rows = offersQuery.data?.ok ? offersQuery.data.offers : [];
    return new Map(rows.map((offer) => [offer.branchCode, offer]));
  }, [offersQuery.data]);

  /**
   * Offer coverage for the products in the result list.
   *
   * So an agent can see which results are on promotion *before* opening one —
   * previously the only way to find out was to open each in turn.
   *
   * `!selected` is doing real work: once a product is open the result list is
   * gone, but its query data is still cached, so without this the tab would
   * keep asking about a list nobody is looking at. The *data* deliberately
   * stays readable while the query is disabled — see `cardScope`.
   */
  const resultCodes = useMemo(() => matches.map((p) => p.itemCode), [matches]);
  const scopes = useOfferScopes(resultCodes, !selected);

  /**
   * The coverage the summary card states.
   *
   * The opened product's own response is authoritative — it is the same read
   * that produced the per-branch prices below, so the card and the rows cannot
   * disagree. Until it lands, the classification the **result list** already
   * made for this exact item stands in. That is not a second source and not a
   * guess: it is the same `classifyOfferScope` over the same upstream response,
   * fetched a moment earlier and still sitting in the browser. It is why an
   * agent sees "15% OFF · all branches" the instant a product opens rather than
   * after a 62 KB round trip.
   */
  const cardScope: ShamsOfferScope | null = selected
    ? ((offersQuery.data?.ok ? offersQuery.data.scope : null) ??
      scopes.byItemCode.get(selected.itemCode) ??
      null)
    : null;

  /**
   * What the Applied Offer column is currently able to say.
   *
   * Three states, because "no offer here", "not loaded yet" and "the CRM could
   * not be asked" are three different things, and a blank cell would read as
   * the first one whichever was true.
   */
  const offerState: FigureState = offersQuery.isPending
    ? "loading"
    : offersQuery.data?.ok
      ? "ready"
      : "unavailable";

  /**
   * The same three states for the MIS half.
   *
   * `unavailable` is the one worth spelling out. When the stock read fails,
   * `stock` is `[]`, and `summariseStock` of nothing is a truthful zero about an
   * empty array and a **falsehood** about the chain — "0 units, 0 of 0
   * branches" is what an agent would read out. So a failed read renders an em
   * dash and the panel directly below carries the reason and a Retry, rather
   * than the card asserting zeroes or holding a pulse that never resolves.
   */
  const stockState: FigureState = stockQuery.isPending
    ? "loading"
    : result?.ok
      ? "ready"
      : "unavailable";

  /** Start the CRM offer read on the click, not after the navigation. */
  const prefetchOffers = usePrefetchProductOffers();
  const onPick = (product: ShamsProduct) => {
    prefetchOffers(product.itemCode);
    onSelect(product);
  };

  /** Branch filter over rows already in memory — never a request. */
  const [branchFilter, setBranchFilter] = useState("");
  // Typing stays responsive on a 137-row table: the input updates immediately,
  // the filtered list catches up.
  const deferredFilter = useDeferredValue(branchFilter);

  const visible = useMemo(
    () => filterBranchStock(stock, deferredFilter, (code) => branchLabels?.get(code)),
    [stock, deferredFilter, branchLabels],
  );

  const summary = useMemo(() => summariseStock(visible), [visible]);
  const totalSummary = useMemo(() => summariseStock(stock), [stock]);
  const filtering = deferredFilter.trim() !== "";

  if (!selected) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="p-4">
            <ProductSearchField
              value={draft}
              onChange={(next) => {
                setDraft(next);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search a product — try mou*n*j*2.5"
              // Only when this tab is the visible one: all three are mounted.
              autoFocus={active}
            />
            <p className="mt-2 text-xs leading-snug text-muted-foreground">
              Search by product name or item code — paste{" "}
              <span className="font-mono">10400746</span> to jump straight to it.{" "}
              <span className="font-medium text-foreground">*</span> stands for anything in between,
              so <span className="font-mono">mou*n*j*2.5</span> finds Mounjaro 2.5. Use ↑ ↓ and
              Enter to pick.
            </p>
          </CardContent>
        </Card>

        {/* The states below are written to be exhaustive on purpose: at every
            combination of searchable / fetching / stale / failed, exactly one of
            them renders. A search box that can go blank, or that can sit in a
            skeleton with nothing ever arriving, is the failure this whole change
            exists to remove — so "nothing rendered" must not be reachable. */}

        {searchQuery.isError && <ErrorState onRetry={() => searchQuery.refetch()} />}

        {/* A failure is the previous term's until the new one has landed; while
            it is placeholder data the list below still shows real results, and
            an error panel over them would be about a search nobody made. */}
        {!searchQuery.isPlaceholderData && searchQuery.data && !searchQuery.data.configured && (
          <NotConfiguredState />
        )}

        {!searchQuery.isPlaceholderData &&
          searchQuery.data &&
          searchQuery.data.configured &&
          !searchQuery.data.ok && (
            <ErrorState kind={searchQuery.data.error?.kind} onRetry={() => searchQuery.refetch()} />
          )}

        {/* Fetching with nothing to show — the first search of a session, or a
            new term after one that found nothing. Keyed on `matches` rather than
            on `data`, which now survives a term change as placeholder data and
            would leave this blank instead. */}
        {searchable && searchQuery.isFetching && matches.length === 0 && <TableSkeleton rows={4} />}

        {searchable && !searchQuery.isFetching && searchQuery.data?.ok && matches.length === 0 && (
          <EmptyState>No products found for “{term.trim()}”.</EmptyState>
        )}

        {matches.length > 0 && (
          <ProductResults
            products={matches}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={onPick}
            busy={stale}
            offerScopes={scopes.byItemCode}
            offersSkipped={scopes.skipped}
            offersLoading={scopes.loading}
          />
        )}

        {!searchable && !searchQuery.isFetching && (
          <EmptyState icon={<Boxes className="h-8 w-8 opacity-40" aria-hidden="true" />}>
            Search for a product to see its stock across branches.
          </EmptyState>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ProductSummaryCard
        product={selected}
        scope={cardScope}
        offerState={offerState}
        units={totalSummary.units}
        branchesWithStock={totalSummary.withStock}
        branchesTotal={totalSummary.branches}
        stockState={stockState}
        onClear={() => {
          setDraft("");
          setBranchFilter("");
          onSelect(null);
        }}
      />

      {stockQuery.isError && <ErrorState onRetry={() => stockQuery.refetch()} />}

      {result && !result.configured && <NotConfiguredState />}

      {result && result.configured && !result.ok && (
        <ErrorState kind={result.error?.kind} onRetry={() => stockQuery.refetch()} />
      )}

      {stockQuery.isFetching && !result && <TableSkeleton />}

      {result?.ok && stock.length === 0 && !stockQuery.isFetching && (
        <EmptyState icon={<PackageX className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          Shams MIS returned no branch stock for this item.
        </EmptyState>
      )}

      {stock.length > 0 && (
        <>
          <Card>
            <CardContent className="space-y-2 p-3 sm:p-4">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  placeholder="Filter branches — code, city or حي"
                  aria-label="Filter branches"
                  autoComplete="off"
                  className="h-10 pl-9 pr-9"
                />
                {branchFilter && (
                  <button
                    type="button"
                    onClick={() => setBranchFilter("")}
                    aria-label="Clear branch filter"
                    className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              {/*
                One line, and only the line that is true.

                The four chain-wide figures moved onto the summary card, where
                they belong — they are facts about the product, not about the
                table. What is genuinely about the table is how much of it a
                filter is hiding, and that is a sentence, not a second dashboard
                repeating the first.
              */}
              <p className="text-xs text-muted-foreground">
                {filtering ? (
                  <>
                    <span className="font-medium tabular-nums text-foreground">
                      {summary.branches}
                    </span>{" "}
                    of <span className="tabular-nums">{totalSummary.branches}</span> branches ·{" "}
                    <span className="tabular-nums">{summary.withStock}</span> in stock ·{" "}
                    <span className="tabular-nums">{summary.units}</span> units matching “
                    {deferredFilter.trim()}”.
                  </>
                ) : (
                  <>
                    Filter by branch code, English or Arabic city, or حي —{" "}
                    <span className="font-mono">P0221</span>, <span dir="auto">جدة</span>,{" "}
                    <span dir="auto">حي الحمراء</span>.
                  </>
                )}
              </p>
            </CardContent>
          </Card>

          {visible.length === 0 ? (
            <EmptyState>No branch matches “{deferredFilter.trim()}”.</EmptyState>
          ) : (
            <BranchStockTable
              rows={visible}
              labels={branchLabels}
              offers={offers}
              offerState={offerState}
              listPrice={selected.retailPrice}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * How much a figure or a cell is currently entitled to claim.
 *
 * Three states rather than two, because "not loaded yet" and "could not be
 * asked" are different from each other and neither is an answer. `unavailable`
 * covers a failed read and a deployment with the connection missing, since both
 * lead to the same honest sentence: nobody asked, so nothing is known. It is
 * never rendered as a zero, and never as "no offer".
 */
type FigureState = "loading" | "ready" | "unavailable";

/**
 * The card above the table: what an agent is asked on the phone, in one strip.
 *
 * Price · applied offer · units · branches. Four figures, and the two that
 * matter most on a call are the two that used to require opening something
 * else.
 *
 * **Three of the four cost no request.** `product.retailPrice` and the name
 * arrive on the search row the agent clicked (or, on a restored `?item=`, on
 * the detail the route already loaded); the units and branch counts are
 * `summariseStock` over the MIS rows the table is drawing anyway. Only the
 * offer waits on anything, and its coverage is usually already known from the
 * result list — so the card is complete before the CRM answers, and says
 * "Checking…" rather than freezing when it is not.
 *
 * Deliberately four figures and no more. Strength and pack size live inside the
 * product name, `retailPriceWithTax` equalled `retailPrice` in every captured
 * response, and `areaName` is a label the page does not trust. A fifth figure
 * here would be one an agent has to read past.
 */
function ProductSummaryCard({
  product,
  scope,
  offerState,
  units,
  branchesWithStock,
  branchesTotal,
  stockState,
  onClear,
}: {
  product: ShamsProduct;
  scope: ShamsOfferScope | null;
  offerState: FigureState;
  units: number;
  branchesWithStock: number;
  branchesTotal: number;
  stockState: FigureState;
  onClear: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Product
            </p>
            <p className="mt-0.5 text-base font-semibold leading-snug sm:text-lg">
              {product.itemName}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{product.itemCode}</p>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded-md border border-border/70 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted focus:bg-muted focus:outline-none"
          >
            Change product
          </button>
        </div>

        {/* One strip divided into four, rather than four surfaces: these are
            parts of a single answer about one product, and boxing each implies
            they are independent readings. `divide-x` carries the separation at
            a fraction of the weight a border-plus-shadow would. */}
        <dl className="grid grid-cols-2 divide-x divide-y divide-border/60 border-t border-border/60 sm:grid-cols-4 sm:divide-y-0">
          <Figure label="Price">
            <span className="text-xl font-semibold tabular-nums sm:text-2xl">
              {fmtSAR(product.retailPrice)}
            </span>
          </Figure>

          <Figure label="Applied offer">
            <AppliedOffer scope={scope} state={offerState} />
          </Figure>

          <Figure label="Units in stock">
            <StockFigure state={stockState}>
              <span className="text-xl font-semibold tabular-nums sm:text-2xl">{units}</span>
            </StockFigure>
          </Figure>

          <Figure label="Branches with stock">
            <StockFigure state={stockState}>
              <span className="text-xl font-semibold tabular-nums text-success sm:text-2xl">
                {branchesWithStock}
                <span className="ml-1 text-sm font-medium text-muted-foreground">
                  of {branchesTotal}
                </span>
              </span>
            </StockFigure>
          </Figure>
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * One figure in the summary strip.
 *
 * Value over label, not value beside it: four inline pairs read as a sentence,
 * and this is a row of independent measures an operator scans down rather than
 * across. Restrained on purpose — no card, no shadow, no icon, because four of
 * these in a bordered strip is an inventory summary and four of them in boxes
 * is a marketing dashboard. The value row keeps a minimum height so a figure
 * arriving does not shift the three beside it.
 *
 * `flex-col-reverse` rather than writing the pair upside down: a description
 * list wants its `dt` before its `dd`, and reversing in CSS keeps the markup
 * legible to a screen reader while the value still reads first on screen.
 */
function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col-reverse px-3 py-2 first:pl-0 sm:px-4">
      <dt className="mt-1.5 truncate text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="flex min-h-[1.75rem] items-baseline leading-none sm:min-h-[2rem]">
        {children}
      </dd>
    </div>
  );
}

/**
 * A figure from the MIS stock read, or an honest stand-in for one.
 *
 * The pulse is sized like the number it will become, so the strip does not jump
 * as figures land at slightly different moments. The em dash is the important
 * half: a failed stock read must not be summarised as zero, and it must not sit
 * under a pulse forever — the error panel directly below carries the reason and
 * the Retry.
 */
function StockFigure({ state, children }: { state: FigureState; children: ReactNode }) {
  if (state === "loading") {
    return <span className="h-5 w-12 animate-pulse rounded bg-muted sm:h-6" aria-hidden="true" />;
  }
  if (state === "unavailable") {
    return <span className="text-xl font-medium text-muted-foreground sm:text-2xl">—</span>;
  }
  return <>{children}</>;
}

/**
 * The offer on the opened product, as one readable value.
 *
 * The scope is in the value, never just "on offer". An offer at 3 of 40
 * stocking branches is a different fact from an offer everywhere, and the
 * branch the customer walks into decides which one applies — so a card that
 * said only "on offer" would be a promise the agent cannot keep.
 *
 * Five states, each of which an agent can act on:
 *
 *   loading      the CRM read is in flight — the rest of the card is readable
 *   all / some   the discount, and how far it reaches
 *   none         the CRM answered, and there is no promotion
 *   unavailable  the CRM could not be asked; **not** the same as "none"
 *   unknown      classified as unknown upstream; treated as unavailable
 */
function AppliedOffer({ scope, state }: { scope: ShamsOfferScope | null; state: FigureState }) {
  if (scope && (scope.kind === "all" || scope.kind === "some")) {
    const all = scope.kind === "all";
    return (
      <span
        className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5"
        // The counts are the evidence behind the word, for anyone who wants to
        // know how far "some" goes without opening anything.
        title={`${scope.branchesWithOffer} of ${scope.branchesAvailable} branches holding this item`}
      >
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-sm font-semibold sm:text-base",
            all ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
          )}
        >
          {scope.offerDisplay ? `${scope.offerDisplay} OFF` : "OFFER"}
        </span>
        <span className="truncate text-[11px] font-medium text-muted-foreground">
          {all ? "all branches" : "some branches"}
        </span>
      </span>
    );
  }

  if (state === "loading") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Checking…
      </span>
    );
  }

  // Never "no offer" for a question nobody managed to ask.
  if (state === "unavailable" || !scope || scope.kind === "unknown") {
    return <span className="text-sm text-muted-foreground">Not checked</span>;
  }

  return <span className="text-lg font-medium text-muted-foreground sm:text-xl">None</span>;
}

/**
 * The product result list.
 *
 * A single bordered surface with plain rows rather than a card each: an agent is
 * scanning a list, and a border around every row is noise that makes the list
 * harder to read, not easier. Name leads at readable size; code and price are
 * secondary and right-aligned so the eye can run down one column.
 *
 * The catalog exposes exactly three fields (name, code, price), and strength and
 * pack size live *inside* the name — `MOUNJARO 2.5 MG 0.5ML PEN, 4'S` — so the
 * name is never truncated and nothing is invented to fill a column.
 */
const ProductResults = memo(function ProductResults({
  products,
  activeIndex,
  onHover,
  onSelect,
  busy,
  offerScopes,
  offersSkipped,
  offersLoading,
}: {
  products: ShamsProduct[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (product: ShamsProduct) => void;
  busy: boolean;
  /** Offer coverage by item code. Absent means "not checked", never "no offer". */
  offerScopes: Map<string, ShamsOfferScope>;
  /** True when the result set was too large to check — see the header line. */
  offersSkipped: boolean;
  offersLoading: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
          <span>
            {products.length} {products.length === 1 ? "product" : "products"}
          </span>
          {/* Subtle, and only while a newer search is in flight — the list
              below stays readable rather than being replaced by a skeleton. */}
          {busy && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              searching
            </span>
          )}
          {/*
            Said once, here, rather than as a badge on every row.

            Offers have no bulk endpoint — one request per item — so a wide
            result set is deliberately not checked. Without this line a row with
            no badge would read as "no offer", which is a claim nobody made.
          */}
          {!busy && offersSkipped && (
            <span className="inline-flex items-center gap-1.5">
              <Tag className="h-3 w-3" aria-hidden="true" />
              Offers not checked — narrow to {MAX_OFFER_SCOPE_ITEMS} results or fewer
            </span>
          )}
          {!busy && !offersSkipped && offersLoading && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              checking offers
            </span>
          )}
        </div>
        <ul role="listbox" aria-label="Product results">
          {products.map((p, index) => (
            <li key={p.itemCode} role="option" aria-selected={index === activeIndex}>
              <button
                type="button"
                onClick={() => onSelect(p)}
                onMouseEnter={() => onHover(index)}
                className={cn(
                  "flex w-full items-baseline justify-between gap-4 border-l-2 px-4 py-2.5 text-left transition-colors",
                  index === activeIndex
                    ? "border-l-primary bg-muted/60"
                    : "border-l-transparent hover:bg-muted/40",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium leading-snug">{p.itemName}</span>
                  {/* Code and offer share the secondary line, so a promotion is
                      visible from the list without adding a row of its own. */}
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-xs text-muted-foreground">{p.itemCode}</span>
                    <OfferScopeBadge scope={offerScopes.get(p.itemCode)} />
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {fmtSAR(p.retailPrice)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
});

/**
 * Whether a product is on offer, and how widely.
 *
 * The distinction is the entire point of the badge. "On offer" alone would be a
 * promise an agent could not keep: an offer at 3 of 40 stocking branches is a
 * different fact from an offer everywhere, and the branch the customer is
 * standing in decides which one applies. So the scope is in the label, always.
 *
 * Three visible states and one invisible one:
 *
 *   all      every branch holding the item also has the offer
 *   some     only a subset — the agent must check the branch
 *   none     renders nothing; a row without a badge has no promotion
 *   unknown  also renders nothing, but the *list* says why (see the header)
 *
 * `none` and `unknown` both render nothing here on purpose — the difference is
 * a property of the whole result set, not of one row, so it is stated once
 * above the list rather than repeated as a shrug on every line.
 */
function OfferScopeBadge({ scope }: { scope: ShamsOfferScope | undefined }) {
  if (!scope || scope.kind === "none" || scope.kind === "unknown") return null;

  const all = scope.kind === "all";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold",
        all ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
      )}
      // The counts are the evidence behind the word, available on hover for
      // anyone who wants to know how far "some" goes without opening the item.
      title={`${scope.branchesWithOffer} of ${scope.branchesAvailable} branches holding this item`}
    >
      <Tag className="h-3 w-3" aria-hidden="true" />
      {scope.offerDisplay ? `${scope.offerDisplay} OFF` : "OFFER"}
      <span className="font-medium opacity-80">{all ? "· all branches" : "· some branches"}</span>
    </span>
  );
}

/**
 * One branch's promotional price.
 *
 * Two things and no more: the discount, and the price the branch charges.
 *
 * The struck-through list price was dropped here. In a card it was a useful
 * second reading; in a 140-row column it is a third number competing with the
 * two that matter, and the one an agent reads out loud is `afterOfferPrice`.
 * The percentage carries the "this is discounted" signal on its own.
 *
 * The percentage comes from the API preformatted (`offer_display`), and the
 * price is `afterOfferPrice` verbatim — nothing is recomputed here, because a
 * discount this component derived could disagree with the one the till applies.
 *
 * Only rendered where there is an offer; the caller leaves the cell blank
 * otherwise, which is quieter than a column of dashes.
 */
function OfferPrice({ offer }: { offer: ShamsCrmOffer }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
        {offer.offerDisplay} OFF
      </span>
      <span className="text-[13px] font-semibold tabular-nums">
        {fmtSAR(offer.afterOfferPrice)}
      </span>
    </span>
  );
}

/**
 * What the portal knows this branch is called, and where it is.
 *
 * Arabic city first, because that is what an agent reads to a customer and what
 * the sheet actually stores; the English name rides along in the tooltip for
 * anyone scanning in Latin. A code the directory does not know yields nulls and
 * the row still renders — see the module header.
 */
function branchPlace(
  labels: Map<string, BranchLabel> | undefined,
  code: string,
): { city: string | null; district: string | null; title: string | undefined } {
  const hit = labels?.get(code);
  if (!hit) return { city: null, district: null, title: undefined };
  const title = [hit.city, hit.cityEnglish, hit.district].filter(Boolean).join(" · ");
  return { city: hit.city || null, district: hit.district, title: title || undefined };
}

/**
 * The branch's price for this product.
 *
 * `offer.price` is the **branch's own** list price, off the same CRM row as the
 * discount beside it, so where a branch has an offer the two figures cannot
 * disagree about what is being discounted. Where the CRM said nothing about a
 * branch there is no branch-specific figure, and the product's MIS retail price
 * is what an agent quotes — so that is what the column shows, the same number
 * the summary card is showing above it.
 *
 * Nothing here is derived: no price on this page is ever computed from a
 * percentage, because a figure this component rounded could differ from the one
 * the till charges.
 */
function branchPrice(offer: ShamsCrmOffer | undefined, listPrice: number): number {
  return offer ? offer.price : listPrice;
}

/** A cell waiting on the CRM. Never a dash — a dash reads as an answer. */
function OfferPending() {
  return <span className="block h-3.5 w-16 animate-pulse rounded bg-muted" aria-hidden="true" />;
}

/**
 * The Applied Offer cell.
 *
 * Blank is reserved for "the CRM could not be asked" — and the table says so
 * once, above, rather than shrugging on 140 rows. When the CRM *did* answer and
 * this branch has no promotion, that is a real answer and gets a real em dash.
 */
function OfferCell({ offer, state }: { offer: ShamsCrmOffer | undefined; state: FigureState }) {
  if (offer) return <OfferPrice offer={offer} />;
  if (state === "loading") return <OfferPending />;
  if (state === "unavailable") return null;
  return <span className="text-muted-foreground">—</span>;
}

/**
 * Branch availability, as an operational table.
 *
 * ## What this is for
 *
 * One product, up to ~140 branches, and an operator answering "who has it,
 * where is that, what does it cost there and is it discounted". That is a
 * register, and a register is read by scanning one column at a time — so the
 * layout that serves it is a dense table with fixed columns, not a surface per
 * branch. A card grid turns 140 rows into 140 bordered boxes and roughly five
 * screens of scrolling, and it makes the page read like a storefront rather
 * than an inventory system.
 *
 * ## The columns
 *
 * Branch · City · District · Units · Status · Price · Applied Offer.
 *
 * **Price and Applied Offer are separate and adjacent.** They are the pair an
 * agent reads out together — "it's 512, and 435 on offer at that branch" — and
 * folding the discount into the price column would lose whichever half the
 * customer actually asked for. Side by side, the comparison is one glance.
 *
 * **City is Arabic and District is the حي**, both from the portal's own branch
 * directory. "Which حي is that in" is the question a customer asks next, and it
 * was previously answerable only by leaving the page.
 *
 * ## The density rules
 *
 * - **Rows separate, cells do not.** A hairline between rows is enough to keep
 *   the eye on one line; ruling every cell would draw a grid the data does not
 *   need.
 * - **The branch code is the strongest thing in the row**, because it is the
 *   identifier the rest of the portal joins on.
 * - **Every number is right-aligned and tabular**, so units and prices each
 *   form a column that can be compared without being read.
 * - **Colour is reserved.** It appears on availability and on an offer, and
 *   nowhere else — a row is never tinted as a whole, so the two things that do
 *   carry colour keep their meaning.
 * - **Long names truncate, they do not wrap.** `table-fixed` plus `truncate`
 *   plus a `title`, so one branch with a paragraph for an address cannot set
 *   the row height for the other 139.
 *
 * ## Small screens
 *
 * Status folds away below `lg`, where availability is still carried by the
 * quantity's own colour. Below `md` the table is replaced rather than scrolled:
 * seven columns cannot be honest at 375px, and a sideways-scrolling table hides
 * the offer column exactly where it matters. The same rows render as a dense
 * three-line list, so nothing is lost and the page never scrolls horizontally.
 *
 * Still no invented thresholds. A branch has a number or it has none.
 */
const BranchStockTable = memo(function BranchStockTable({
  rows,
  labels,
  offers,
  offerState,
  listPrice,
}: {
  rows: ShamsBranchStock[];
  labels: Map<string, BranchLabel> | undefined;
  /** Offer pricing by branch code. Empty when there is none, or none loaded. */
  offers: Map<string, ShamsCrmOffer>;
  offerState: FigureState;
  /** The product's MIS retail price, for branches the CRM did not price. */
  listPrice: number;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {offerState === "unavailable" && (
          <p className="border-b border-border/60 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            Offer pricing is unavailable, so Applied Offer is blank — which is not the same as “no
            offer”. Stock and prices below are unaffected.
          </p>
        )}

        {/* Desktop: the register. */}
        <table className="hidden w-full table-fixed text-sm md:table">
          <thead>
            <tr className="border-b border-border/60 bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <th className={cn(TH, "w-[11%]")}>Branch</th>
              <th className={cn(TH, "w-[14%]")}>City</th>
              <th className={TH}>District</th>
              <th className={cn(TH, "w-[9%] text-right")}>Units</th>
              <th className={cn(TH, "hidden w-[12%] lg:table-cell")}>Status</th>
              <th className={cn(TH, "w-[13%] text-right")}>Price</th>
              <th className={cn(TH, "w-[19%]")}>Applied Offer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const place = branchPlace(labels, row.branchCode);
              const offer = offers.get(row.branchCode);
              const out = row.quantity <= 0;
              return (
                <tr
                  key={row.branchCode}
                  className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/30"
                >
                  <td className={cn(TD, "py-2 font-mono text-[13px] font-semibold")}>
                    {row.branchCode}
                  </td>
                  <td
                    className={cn(TD, "truncate py-2 font-medium")}
                    dir="auto"
                    title={place.title}
                  >
                    {place.city ?? <span className="font-normal text-muted-foreground">—</span>}
                  </td>
                  <td
                    className={cn(TD, "truncate py-2 text-muted-foreground")}
                    dir="auto"
                    title={place.district ?? undefined}
                  >
                    {place.district ?? "—"}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right text-[15px] font-semibold tabular-nums",
                      out ? "text-destructive/70" : "text-foreground",
                    )}
                  >
                    {out ? "0" : row.quantity}
                  </td>
                  <td className={cn(TD, "hidden py-2 lg:table-cell")}>
                    <StockStatus quantity={row.quantity} />
                  </td>
                  <td className={cn(TD, "py-2 text-right tabular-nums")}>
                    {fmtSAR(branchPrice(offer, listPrice))}
                  </td>
                  <td className={cn(TD, "py-2")}>
                    <OfferCell offer={offer} state={offerState} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Mobile: the same rows, three lines each. No sideways scrolling. */}
        <ul className="divide-y divide-border/40 md:hidden">
          {rows.map((row) => {
            const place = branchPlace(labels, row.branchCode);
            const offer = offers.get(row.branchCode);
            const out = row.quantity <= 0;
            return (
              <li key={row.branchCode} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-mono text-[13px] font-semibold">{row.branchCode}</span>
                    <span className="truncate text-sm font-medium" dir="auto">
                      {place.city ?? "—"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[15px] font-semibold tabular-nums",
                      out ? "text-destructive/70" : "text-foreground",
                    )}
                  >
                    {out ? "0" : row.quantity}
                  </span>
                </div>
                {place.district && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="auto">
                    {place.district}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StockStatus quantity={row.quantity} />
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {fmtSAR(branchPrice(offer, listPrice))}
                  </span>
                  <OfferCell offer={offer} state={offerState} />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
});

/**
 * Whether a branch has the item.
 *
 * A dot and a word, not a filled pill. Down 140 rows a pill on every line
 * becomes a column of coloured blocks that pulls the eye away from the numbers
 * beside it; a small dot carries the same two-state signal at a fraction of the
 * visual weight and still reads at a glance. The word stays because a dot alone
 * is a legend nobody has.
 *
 * `Out of stock` is the one an agent is scanning for, so it keeps the
 * destructive tone and a slightly heavier weight. No banding between the two,
 * because the application defines no "low stock" threshold to band on.
 */
function StockStatus({ quantity }: { quantity: number }) {
  const out = quantity <= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs",
        out ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", out ? "bg-destructive" : "bg-success")}
        aria-hidden="true"
      />
      {out ? "Out of stock" : "In stock"}
    </span>
  );
}
