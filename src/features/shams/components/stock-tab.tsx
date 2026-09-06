/**
 * Branch Stock — find a product, then read its availability per branch.
 *
 * This is the whole catalog experience since the standalone Products tab was
 * removed: the same `product/search` lookup starts here, and choosing a result
 * loads the stock the agent came for.
 *
 * ## Where the numbers come from
 *
 *   product name, code, list price   local catalogue (`shams_product_catalog`)
 *   offers, coverage, offer price    local dataset  (`shams_offer_products`,
 *                                                    `shams_offers`)
 *   branch quantities                **live** Shams Portal/MIS `product/stock`
 *   city, district                   MilaServ's own branch directory
 *
 * Exactly one of those is a third-party request, and it is the one that has to
 * be: a quantity goes out of date in seconds. Everything else is an indexed
 * read of MilaPortal's own database, so opening a product no longer waits on
 * Shams CRM at all — the offer sweep in `lib/shams-crm/offer-sync.server.ts`
 * did that work in the background, hours ago.
 *
 * ## Four decisions worth stating
 *
 * **The discounted price is on the search row.** An agent should not have to
 * open a product to find out what it costs today. A row shows the list price and
 * the offer price together, and it shows them **only when a single product-level
 * figure is defensible** — see `summariseProductOffer`. A branch-specific offer
 * gets its badge and its coverage, and its per-branch prices in the table below,
 * because there is no one price to quote.
 *
 * **No invented thresholds.** The application defines no "low stock" boundary,
 * so none is shown. A branch either has none — a fact, marked destructive
 * because it is the answer an agent is scanning for — or it has a number.
 *
 * **The branch results are a register.** One product against ~140 branches is
 * operational data read by scanning a column, so it is a dense table whose
 * header and cells share one `<colgroup>` — see `BranchStockTable` for why that
 * is structural rather than careful.
 *
 * **Branch names, cities and districts come from MilaServ.** The MIS returns
 * `branchName` identical to `branchCode` on every row, so it is not a display
 * name. `branchCode` is the same identifier as `branches.branch_no`, so the
 * portal's own directory supplies the Arabic city and the حي — the same
 * directory the Branch Directory page reads, never a second list.
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
import type { ShamsCrmOffer } from "@/lib/shams-crm/types";
import { hasProductOfferPrice, type ShamsOfferSummary } from "@/lib/shams-crm/offer-summary";
import {
  MIN_QUERY_LENGTH,
  useBranchLabels,
  useDebounced,
  useOfferSummaries,
  useProductDetail,
  useProductOffers,
  useProductSearch,
  type BranchLabel,
} from "@/features/shams/hooks/use-shams-data";
import { EmptyState, ErrorState, NotConfiguredState, TableSkeleton } from "./states";

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How much a figure is currently entitled to claim.
 *
 * Four states rather than two, because "not loaded yet", "could not be read"
 * and "nobody has swept this yet" are all different from each other and none of
 * them is an answer. `notSynced` in particular is the one this phase introduced
 * and the one that must never be rendered as "no offer": before the first sweep
 * completes, every product looks offer-free, and quoting full price on a shelf
 * of promotions is the failure mode worth a whole state to prevent.
 */
type OfferState = "loading" | "ready" | "unavailable" | "notSynced";

/** Money in the table: bare and exact, so a column lines up on the decimal. */
const money = (value: number) => fmtSAR(value, { bare: true, exact: true });

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

  /** The one live third-party read on this page. */
  const stockQuery = useProductDetail(selected?.itemCode ?? null, Boolean(selected));
  const result = stockQuery.data;
  const stock = useMemo(() => result?.stock ?? [], [result]);

  const { data: branchLabels } = useBranchLabels();

  /**
   * Per-branch offer pricing for the opened product, read locally.
   *
   * No prefetch beside it and no CRM request behind it: two indexed reads of
   * MilaPortal's own tables, filled by the background sweep.
   */
  const offersQuery = useProductOffers(selected?.itemCode ?? null);
  const offers = useMemo(() => {
    const rows = offersQuery.data?.ok ? offersQuery.data.offers : [];
    return new Map(rows.map((offer) => [offer.branchCode, offer]));
  }, [offersQuery.data]);

  /**
   * Offer verdicts for every product in the result list.
   *
   * One local query for the whole set — the twelve-item cap this replaces
   * existed because each item used to be its own ~62 KB CRM request, and there
   * is no upstream cost left to cap.
   *
   * `!selected` is doing real work: once a product is open the result list is
   * gone, but its query data is still cached, so without this the tab would keep
   * re-reading a list nobody is looking at. The *data* deliberately stays
   * readable while disabled — see `cardSummary`.
   */
  const resultCodes = useMemo(() => matches.map((p) => p.itemCode), [matches]);
  const listOffers = useOfferSummaries(resultCodes, !selected);

  /**
   * The verdict the summary card states.
   *
   * The opened product's own read is authoritative — it is the same local row
   * that priced the branches below, so the card and the table cannot disagree.
   * Until it lands, the verdict the **result list** already read for this exact
   * item stands in, which is why an agent sees the offer the instant a product
   * opens rather than after a round trip.
   */
  const cardSummary: ShamsOfferSummary | null = selected
    ? ((offersQuery.data?.ok ? offersQuery.data.summary : null) ??
      listOffers.byItemCode.get(selected.itemCode) ??
      null)
    : null;

  /** What the opened product's offer figures are entitled to claim. */
  const offerState: OfferState = offersQuery.isPending
    ? "loading"
    : !offersQuery.data?.ok
      ? "unavailable"
      : !offersQuery.data.synced
        ? "notSynced"
        : "ready";

  /**
   * The same three states for the MIS half.
   *
   * `unavailable` is the one worth spelling out. When the stock read fails,
   * `stock` is `[]`, and `summariseStock` of nothing is a truthful zero about an
   * empty array and a falsehood about the chain — "0 units, 0 branches" is what
   * an agent would read out. So a failed read renders an em dash and the panel
   * below carries the reason and a Retry.
   */
  const stockState: OfferState = stockQuery.isPending
    ? "loading"
    : result?.ok
      ? "ready"
      : "unavailable";

  /** Branch filter over rows already in memory — never a request. */
  const [branchFilter, setBranchFilter] = useState("");
  // Typing stays responsive on a 137-row table: the input updates immediately,
  // the filtered list catches up.
  const deferredFilter = useDeferredValue(branchFilter);

  const visible = useMemo(
    () => filterBranchStock(stock, deferredFilter, (code) => branchLabels?.get(code)),
    [stock, deferredFilter, branchLabels],
  );

  /**
   * The spread of per-branch offer prices, from rows already in memory.
   *
   * Feeds the summary card's "Offer price" when the branches disagree and there
   * is therefore no single product-level figure. Never a request: these are the
   * same offers the table below renders.
   */
  const offerSpread = useMemo(() => offerPriceSpread(offers), [offers]);

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
            onSelect={onSelect}
            busy={stale}
            summaries={listOffers.byItemCode}
            offersSynced={listOffers.synced}
            offersLoading={listOffers.loading}
            offersFailed={listOffers.failed}
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
        summary={cardSummary}
        offerSpread={offerSpread}
        offerState={offerState}
        units={totalSummary.units}
        availableBranches={totalSummary.withStock}
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
        <Card className="overflow-hidden">
          {/*
            The filter belongs to the table, so it sits inside the same surface
            rather than floating above it in a card of its own.

            It previously carried `border-transparent … shadow-none` over a
            tinted strip, which made a live text input indistinguishable from a
            caption — an agent could not tell there was anything to type into.
            It now looks like what it is: a bordered field on the card's own
            background, with a focus ring. The layout is explicit rather than
            emergent — the field takes the row and the count sits at the end,
            and `min-w-0` keeps the field from being squeezed to nothing by a
            long count.
          */}
          <div className="flex flex-col gap-2 border-b bg-muted/20 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
            <div className="relative w-full min-w-0 sm:max-w-md sm:flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                // The instruction is the example. A paragraph under the box said
                // the same thing and cost a line on every screen.
                placeholder="Filter by branch, city or district…"
                aria-label="Filter branches by code, city or district"
                autoComplete="off"
                className="h-9 w-full border-input bg-background pl-8 pr-8 text-[13px]"
              />
              {branchFilter && (
                <button
                  type="button"
                  onClick={() => setBranchFilter("")}
                  aria-label="Clear branch filter"
                  className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {filtering ? (
                <>
                  <span className="font-medium text-foreground">{summary.branches}</span> of{" "}
                  {totalSummary.branches} branches · {summary.withStock} in stock · {summary.units}{" "}
                  units
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">{totalSummary.branches}</span>{" "}
                  branches
                </>
              )}
            </p>
          </div>

          {offerState === "notSynced" && (
            <p className="border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:px-4">
              Offer data has not been synced yet, so the Applied Offer column is empty — that is not
              the same as “no offer”. Stock and prices below are unaffected.
            </p>
          )}
          {offerState === "unavailable" && (
            <p className="border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:px-4">
              Offer data could not be read, so the Applied Offer column is empty — that is not the
              same as “no offer”. Stock and prices below are unaffected.
            </p>
          )}

          {visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No branch matches “{deferredFilter.trim()}”.
            </p>
          ) : (
            <BranchStockTable
              rows={visible}
              labels={branchLabels}
              offers={offers}
              offerState={offerState}
              listPrice={selected.retailPrice}
            />
          )}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Offers, rendered                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether a product is on offer, and how widely.
 *
 * The scope is in the label, always. "On offer" alone would be a promise an
 * agent could not keep: an offer at 3 of 40 stocking branches is a different
 * fact from an offer everywhere, and the branch the customer walks into decides
 * which one applies.
 *
 * Renders nothing for `none` (a checked product with no promotion) and nothing
 * for `unknown` (one the sweep has not reached). Both are absences, and the
 * difference between them is a property of the dataset rather than of one row —
 * so it is stated once, above the list, and never as a shrug on every line.
 */
function OfferBadge({
  summary,
  size = "sm",
}: {
  summary: ShamsOfferSummary | null | undefined;
  size?: "sm" | "md";
}) {
  if (!summary || summary.scope === "none" || summary.scope === "unknown") return null;

  const all = summary.scope === "all";
  /*
   * No single percentage, because the offering branches quote more than one.
   *
   * This is a real state with real products behind it — item 10612992 runs at
   * 50% in 135 branches and 30% in three — and the badge used to render it as a
   * bare "OFFER · all branches". Coverage was true and the discount was simply
   * missing, which reads as a broken badge rather than as the fact it is. It
   * says "varies by branch" now, and takes the cautious tone even at full
   * coverage: an agent must not read "all branches" and infer one price.
   */
  const varies = summary.offerDisplay === null;
  const uniform = all && !varies;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded font-semibold",
        uniform ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
        size === "md" ? "px-2 py-0.5 text-[13px]" : "px-1.5 py-0.5 text-[11px]",
      )}
      // The counts are the evidence behind the word, for anyone who wants to
      // know how far "some" goes without opening anything.
      title={`${summary.branchesWithOffer} of ${summary.branchesAvailable} branches holding this item`}
    >
      <Tag className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden="true" />
      {varies ? "OFFER" : `${summary.offerDisplay} OFF`}
      <span className="font-medium opacity-80">
        {varies ? "· varies by branch" : all ? "· all branches" : "· some branches"}
      </span>
    </span>
  );
}

/**
 * The spread of discounted prices across the branches that carry the offer.
 *
 * Only ever computed from rows already on screen — the per-branch offers the
 * table below is drawing — so it costs nothing and cannot disagree with them.
 * Null when nothing is loaded; a single figure when every branch agrees, which
 * is the ordinary case and is what `hasProductOfferPrice` is already showing.
 */
function offerPriceSpread(offers: Map<string, ShamsCrmOffer>): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const offer of offers.values()) {
    if (offer.afterOfferPrice < min) min = offer.afterOfferPrice;
    if (offer.afterOfferPrice > max) max = offer.afterOfferPrice;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * A product's price, with its discounted price beneath when one is defensible.
 *
 * The list price is struck through and demoted rather than removed, because the
 * two figures are read together on a call — "it's sixty sixty-two, forty-eight
 * fifty on offer" — and a row showing only the discounted price hides what the
 * customer is being saved.
 *
 * `hasProductOfferPrice` is the single gate, and it is strict: an offer that
 * does not reach every stocking branch, or whose branches quote different
 * figures, produces no product-level price here at all. That product shows its
 * catalogue price and its badge, and the per-branch truth is one click away in
 * the table. Showing a global discounted price for a branch-specific offer would
 * be a number nobody charges.
 */
function PriceStack({
  listPrice,
  summary,
}: {
  listPrice: number;
  summary: ShamsOfferSummary | null | undefined;
}) {
  if (!hasProductOfferPrice(summary)) {
    return <span className="text-sm font-semibold tabular-nums">{fmtSAR(listPrice)}</span>;
  }

  return (
    <span className="flex flex-col items-end leading-tight">
      <span className="text-xs tabular-nums text-muted-foreground line-through">
        {fmtSAR(summary.unitPrice)}
      </span>
      <span className="text-sm font-semibold tabular-nums text-success">
        {fmtSAR(summary.offerPrice)}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* The result list                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The product result list.
 *
 * A single bordered surface with plain rows rather than a card each: an agent is
 * scanning a list, and a border around every row is noise that makes the list
 * harder to read, not easier.
 *
 * **The discounted price is here, on the row.** That is the change this phase
 * exists for. It costs nothing extra — one local query answered for every
 * product in the set before the list rendered — where the previous design could
 * only afford a badge for twelve rows and told the agent to open a product to
 * learn the price.
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
  summaries,
  offersSynced,
  offersLoading,
  offersFailed,
}: {
  products: ShamsProduct[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (product: ShamsProduct) => void;
  busy: boolean;
  /** Offer verdicts by item code. Absent means "not swept", never "no offer". */
  summaries: Map<string, ShamsOfferSummary>;
  offersSynced: boolean;
  offersLoading: boolean;
  offersFailed: boolean;
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

            A row without a badge means "no promotion" only when the dataset can
            actually answer. Before the first sweep, or when the read failed,
            every row looks offer-free — so the list says which it is, and an
            agent is never left inferring a claim nobody made.
          */}
          {!busy && offersFailed && (
            <span className="inline-flex items-center gap-1.5">
              <Tag className="h-3 w-3" aria-hidden="true" />
              Offer data unavailable — prices shown are list prices
            </span>
          )}
          {!busy && !offersFailed && !offersSynced && !offersLoading && (
            <span className="inline-flex items-center gap-1.5">
              <Tag className="h-3 w-3" aria-hidden="true" />
              Offer data not synced yet
            </span>
          )}
          {!busy && offersLoading && (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              reading offers
            </span>
          )}
        </div>
        <ul role="listbox" aria-label="Product results">
          {products.map((p, index) => {
            const summary = summaries.get(p.itemCode);
            return (
              <li key={p.itemCode} role="option" aria-selected={index === activeIndex}>
                <button
                  type="button"
                  onClick={() => onSelect(p)}
                  onMouseEnter={() => onHover(index)}
                  className={cn(
                    "flex w-full items-center justify-between gap-4 border-l-2 px-4 py-2.5 text-left transition-colors",
                    index === activeIndex
                      ? "border-l-primary bg-muted/60"
                      : "border-l-transparent hover:bg-muted/40",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium leading-snug">{p.itemName}</span>
                    {/* Code and offer share the secondary line, so a promotion
                        is visible from the list without a row of its own. */}
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs text-muted-foreground">{p.itemCode}</span>
                      <OfferBadge summary={summary} />
                    </span>
                  </span>
                  <span className="shrink-0">
                    <PriceStack listPrice={p.retailPrice} summary={summary} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
});

/* -------------------------------------------------------------------------- */
/* The summary card                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The card above the table: what an agent is asked on the phone, in one strip.
 *
 * Name and code, then five figures — **normal price · applied offer · offer
 * price · units in stock · available branches**. Nothing else. There is no
 * "of 137": the chain's branch count is not a fact about this product, and an
 * agent asked "where can I get it" wants the number of places that have it.
 *
 * **The offer costs no third-party request.** It is read from MilaPortal's own
 * tables, and usually it is already in the browser from the result list the
 * agent clicked, so the whole card is complete in the frame the product opens.
 */
function ProductSummaryCard({
  product,
  summary,
  offerSpread,
  offerState,
  units,
  availableBranches,
  stockState,
  onClear,
}: {
  product: ShamsProduct;
  summary: ShamsOfferSummary | null;
  /** Per-branch offer price spread, for the disagreeing case. Never a request. */
  offerSpread: { min: number; max: number } | null;
  offerState: OfferState;
  units: number;
  availableBranches: number;
  stockState: OfferState;
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

        {/* One strip divided into five, rather than five surfaces: these are
            parts of a single answer about one product, and boxing each implies
            they are independent readings. `divide-x` carries the separation at
            a fraction of the weight a border-plus-shadow would. */}
        <dl className="grid grid-cols-2 divide-x divide-y divide-border/60 border-t border-border/60 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5">
          <Figure label="Price">
            <span className="text-xl font-semibold tabular-nums sm:text-2xl">
              {fmtSAR(product.retailPrice)}
            </span>
          </Figure>

          <Figure label="Applied offer">
            <AppliedOffer summary={summary} state={offerState} />
          </Figure>

          <Figure label="Offer price">
            <OfferPriceFigure summary={summary} spread={offerSpread} state={offerState} />
          </Figure>

          <Figure label="Units in stock">
            <StockFigure state={stockState}>
              <span className="text-xl font-semibold tabular-nums sm:text-2xl">{units}</span>
            </StockFigure>
          </Figure>

          <Figure label="Available branches">
            <StockFigure state={stockState}>
              <span className="text-xl font-semibold tabular-nums text-success sm:text-2xl">
                {availableBranches}
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
 * Value over label, not value beside it: five inline pairs read as a sentence,
 * and this is a row of independent measures an operator scans down rather than
 * across. Restrained on purpose — no card, no shadow, no icon.
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
 * What this product costs on offer — one figure, a range, or nothing.
 *
 * The em dash this replaces was the second half of the 10612992 report, and the
 * complaint was fair: a card reading `APPLIED OFFER  OFFER · all branches` above
 * `OFFER PRICE  —` looks like a page that failed to load its own data. What was
 * actually true is that the product has two offers, and the dash said none of
 * that.
 *
 * So the dash is now reserved for the one thing it can honestly mean — the
 * dataset was asked and this product has no promotion — and the disagreeing
 * case shows the **spread**, read off the per-branch rows already on screen:
 *
 *   69.00 – 96.60 SAR      two offers, and the agent can see both ends
 *   varies by branch       offers exist but no branch prices are loaded
 *   69.00 SAR              every offering branch agrees; the ordinary case
 *   —                      no promotion at all
 *
 * A range is not a global price and cannot be mistaken for one: it names two
 * numbers, which is precisely the claim "there is no single number" made
 * legible. Nothing here is derived from a percentage, and the branch a customer
 * walks into still decides which end they pay — which is what the table below
 * is for.
 */
function OfferPriceFigure({
  summary,
  spread,
  state,
}: {
  summary: ShamsOfferSummary | null;
  spread: { min: number; max: number } | null;
  state: OfferState;
}) {
  // One agreed figure. The common case, and the one an agent quotes.
  if (hasProductOfferPrice(summary)) {
    return (
      <span className="text-xl font-semibold tabular-nums text-success sm:text-2xl">
        {fmtSAR(summary.offerPrice)}
      </span>
    );
  }

  const hasOffer = summary?.scope === "all" || summary?.scope === "some";

  if (hasOffer) {
    if (state === "loading") {
      return <span className="h-5 w-16 animate-pulse rounded bg-muted sm:h-6" aria-hidden="true" />;
    }
    // Both ends, from the rows the table is drawing. `min === max` would mean
    // the branches agree after all, which `hasProductOfferPrice` would have
    // caught — but rendering it as one figure rather than "x – x" costs a line
    // and cannot be wrong.
    if (spread) {
      return (
        <span
          className="text-base font-semibold tabular-nums text-warning sm:text-lg"
          title="Branches quote different offer prices for this product. The table below shows each branch's own price."
        >
          {spread.min === spread.max
            ? fmtSAR(spread.min)
            : `${money(spread.min)} – ${money(spread.max)} SAR`}
        </span>
      );
    }
    return <span className="text-base font-medium text-muted-foreground">Varies by branch</span>;
  }

  // Asked, and there is no promotion. The one thing a dash may mean.
  return <span className="text-xl font-medium text-muted-foreground sm:text-2xl">—</span>;
}

/**
 * A figure from the live MIS stock read, or an honest stand-in for one.
 *
 * The pulse is sized like the number it will become, so the strip does not jump
 * as figures land. The em dash is the important half: a failed stock read must
 * not be summarised as zero, and it must not sit under a pulse forever — the
 * error panel directly below carries the reason and the Retry.
 */
function StockFigure({ state, children }: { state: OfferState; children: ReactNode }) {
  if (state === "loading") {
    return <span className="h-5 w-12 animate-pulse rounded bg-muted sm:h-6" aria-hidden="true" />;
  }
  if (state !== "ready") {
    return <span className="text-xl font-medium text-muted-foreground sm:text-2xl">—</span>;
  }
  return <>{children}</>;
}

/**
 * The offer on the opened product, as one readable value.
 *
 * Five states, each of which an agent can act on:
 *
 *   loading      the local read is in flight — the rest of the card is readable
 *   all / some   the discount, and how far it reaches
 *   none         the dataset was asked, and there is no promotion
 *   unavailable  the dataset could not be read; **not** the same as "none"
 *   notSynced    no sweep has completed yet; also **not** the same as "none"
 */
function AppliedOffer({
  summary,
  state,
}: {
  summary: ShamsOfferSummary | null;
  state: OfferState;
}) {
  if (summary && (summary.scope === "all" || summary.scope === "some")) {
    return <OfferBadge summary={summary} size="md" />;
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
  if (state === "unavailable") {
    return <span className="text-sm text-muted-foreground">Unavailable</span>;
  }
  if (state === "notSynced") {
    return <span className="text-sm text-muted-foreground">Not synced</span>;
  }
  if (!summary || summary.scope === "unknown") {
    return <span className="text-sm text-muted-foreground">Not checked</span>;
  }

  return <span className="text-lg font-medium text-muted-foreground sm:text-xl">None</span>;
}

/* -------------------------------------------------------------------------- */
/* The register                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the portal knows this branch is called, and where it is.
 *
 * Arabic city and Arabic حي, both from MilaServ's own branch directory; the
 * English name rides along in the tooltip for anyone scanning in Latin. A code
 * the directory does not know yields nulls and the row still renders.
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
 * `offer.price` is the **branch's own** list price, off the same row as the
 * discount beside it, so where a branch has an offer the two figures cannot
 * disagree about what is being discounted. Where the dataset holds nothing for a
 * branch there is no branch-specific figure, and the product's catalogue price
 * is what an agent quotes — the same number the card above shows.
 *
 * Nothing is derived: no price on this page is ever computed from a percentage.
 */
function branchPrice(offer: ShamsCrmOffer | undefined, listPrice: number): number {
  return offer ? offer.price : listPrice;
}

/**
 * Arabic that does not drag its cell with it.
 *
 * ## `dir="ltr"` is the whole fix, and it is not a hack
 *
 * `<bdi>` was already here to isolate the run's direction, and it does that
 * job. What it also does — and what broke the table — is default its **own**
 * `dir` to `auto`: the HTML standard specifies `dir=auto` for `bdi`, so an
 * Arabic-only value resolves the element to `direction: rtl`, and a *block*
 * box with `direction: rtl` puts `text-align: start` at its **right** edge.
 *
 * The column was never wrong. `جدة` was sitting flush against the far side of a
 * correctly-sized City column while the `CITY` header sat at the near side, and
 * the gap between them read as a header pointing at the wrong column. Measured
 * on the real markup: 60.2 px of empty space before the text began, against
 * 12 px (the cell padding) once the direction is stated.
 *
 * So the element's direction is pinned to the table's, while `<bdi>` keeps
 * isolating: the Arabic characters still shape and order right-to-left as a
 * run, the block still starts where the header starts, and the ellipsis still
 * lands at the end a left-to-right reader expects. Nothing is centred, nothing
 * is nudged, and no offset compensates for anything.
 */
function Place({ value, title }: { value: string | null; title?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <bdi dir="ltr" className="block truncate" title={title ?? value}>
      {value}
    </bdi>
  );
}

/** A cell waiting on the dataset. Never a dash — a dash reads as an answer. */
function OfferPending() {
  return <span className="block h-3 w-14 animate-pulse rounded bg-muted" aria-hidden="true" />;
}

/**
 * The Applied Offer cell: the discount and the price it produces, together.
 *
 * Blank is reserved for "the dataset could not be asked" — and the table says
 * why once, above, rather than shrugging on 140 rows. When the dataset *did*
 * answer and this branch has no promotion, that is a real answer and gets a real
 * em dash.
 *
 * `afterOfferPrice` is rendered verbatim. Nothing here recomputes a discount:
 * rounding is Shams's to decide, and a figure this component derived could
 * differ from the one the till applies.
 */
function OfferCell({ offer, state }: { offer: ShamsCrmOffer | undefined; state: OfferState }) {
  if (offer) {
    return (
      <span className="flex items-baseline justify-end gap-2 whitespace-nowrap">
        {/* The discount is context; the price is the answer. The chip is
            deliberately neutral so it cannot out-shout the figure beside it. */}
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {offer.offerDisplay}
        </span>
        <span
          className="font-semibold tabular-nums text-success"
          title={fmtSAR(offer.afterOfferPrice)}
        >
          {money(offer.afterOfferPrice)}
        </span>
      </span>
    );
  }
  if (state === "loading") return <OfferPending />;
  if (state !== "ready") return null;
  return <span className="block text-right text-muted-foreground">—</span>;
}

/**
 * Whether a branch has the item. Compact, and the same shape on every row.
 *
 * A dot and a word rather than a filled pill: down 140 rows a pill on every line
 * becomes a column of coloured blocks that pulls the eye away from the numbers
 * beside it. `Out` keeps the destructive tone because it is the answer an agent
 * is scanning for. No banding between the two — the application defines no "low
 * stock" threshold to band on.
 */
function StockStatus({ quantity }: { quantity: number }) {
  const out = quantity <= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]",
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

/** Header and body cell padding, defined once so the two cannot drift apart. */
const TH_CELL =
  "px-3 py-2 text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap first:pl-4 last:pr-4";
const TD_CELL = "px-3 py-1.5 align-middle first:pl-4 last:pr-4";

/**
 * Branch availability, as an operational register.
 *
 * ## The alignment guarantee
 *
 * The header lines up with its column because it **cannot not**: one `<table>`,
 * `table-fixed`, and a single `<colgroup>` whose seven `<col>` elements are the
 * only place any width is stated. A `<th>` and the `<td>`s below it are the same
 * table column by definition of the element, so there is no arrangement of CSS,
 * no breakpoint and no content length that can make them disagree — which is
 * exactly what a header and a body built from independent flex rows could not
 * promise.
 *
 * Nothing is nudged by hand. There is no pixel offset anywhere in this
 * component, because there is nothing left for one to correct.
 *
 * ## The columns
 *
 * Branch · City · District · Units · Status · Price · Applied Offer.
 *
 * **Price and Applied Offer are separate and adjacent.** They are the pair an
 * agent reads out together — "it's 512, and 435 on offer at that branch" — and
 * folding the discount into the price column would lose whichever half the
 * customer asked for. Side by side, the comparison is one glance.
 *
 * ## Density
 *
 * - **Rows separate, cells do not.** A hairline between rows is enough; ruling
 *   every cell would draw a grid the data does not need.
 * - **Every number is right-aligned and tabular**, so Units and Price each form
 *   a column that can be compared without being read.
 * - **Colour is reserved** for availability and for an offer, and appears
 *   nowhere else, so the two things that carry it keep their meaning.
 * - **Long names truncate with a `title`**, so one paragraph-length address
 *   cannot set the row height for the other 139.
 * - **Arabic is isolated with `<bdi>`**, so it reads right-to-left inside a cell
 *   that stays aligned with its header. See `Place`.
 *
 * ## Responsive
 *
 * Deliberate, and only two states. From `md` up it is this table, in a wrapper
 * that may scroll horizontally — it will not at any ordinary width, because
 * `min-w` is below the `md` breakpoint, but the wrapper means a narrow window
 * scrolls one bounded region instead of misaligning seven columns. Below `md`
 * the table is replaced by a structured card per branch: seven columns cannot be
 * honest at 375px, and a sideways-scrolling table hides the offer column exactly
 * where it matters.
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
  /** Offer pricing by branch code, from the local dataset. */
  offers: Map<string, ShamsCrmOffer>;
  offerState: OfferState;
  /** The product's catalogue price, for branches the dataset did not price. */
  listPrice: number;
}) {
  return (
    <>
      {/* Desktop and tablet: the register. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[44rem] table-fixed border-collapse text-[13px]">
          {/*
            The single source of column width in this component. Header and body
            read it by being the same table; nothing else states a width.
          */}
          <colgroup>
            <col className="w-[10%]" />
            <col className="w-[13%]" />
            <col />
            <col className="w-[8%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[19%]" />
          </colgroup>
          <thead>
            <tr className="border-b bg-muted/40 text-left text-muted-foreground">
              <th scope="col" className={TH_CELL}>
                Branch
              </th>
              <th scope="col" className={TH_CELL}>
                City
              </th>
              <th scope="col" className={TH_CELL}>
                District
              </th>
              <th scope="col" className={cn(TH_CELL, "text-right")}>
                Units
              </th>
              <th scope="col" className={TH_CELL}>
                Status
              </th>
              <th scope="col" className={cn(TH_CELL, "text-right")}>
                Price
              </th>
              <th scope="col" className={cn(TH_CELL, "text-right")}>
                Applied Offer
              </th>
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
                  <td className={cn(TD_CELL, "font-mono text-xs font-semibold")}>
                    {row.branchCode}
                  </td>
                  <td className={cn(TD_CELL, "font-medium")}>
                    <Place value={place.city} title={place.title} />
                  </td>
                  <td className={cn(TD_CELL, "text-muted-foreground")}>
                    <Place value={place.district} />
                  </td>
                  <td
                    className={cn(
                      TD_CELL,
                      "text-right font-semibold tabular-nums",
                      out ? "text-destructive/70" : "text-foreground",
                    )}
                  >
                    {out ? "0" : row.quantity}
                  </td>
                  <td className={TD_CELL}>
                    <StockStatus quantity={row.quantity} />
                  </td>
                  <td
                    className={cn(TD_CELL, "text-right tabular-nums")}
                    title={fmtSAR(branchPrice(offer, listPrice))}
                  >
                    {money(branchPrice(offer, listPrice))}
                  </td>
                  <td className={TD_CELL}>
                    <OfferCell offer={offer} state={offerState} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Narrow: a structured card per branch. Nothing is lost and the page
          never scrolls sideways. */}
      <ul className="divide-y divide-border/40 md:hidden">
        {rows.map((row) => {
          const place = branchPlace(labels, row.branchCode);
          const offer = offers.get(row.branchCode);
          const out = row.quantity <= 0;
          return (
            <li key={row.branchCode} className="px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-xs font-semibold">{row.branchCode}</span>
                  <span className="min-w-0 truncate text-[13px] font-medium">
                    <Place value={place.city} title={place.title} />
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
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <Place value={place.district} />
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <StockStatus quantity={row.quantity} />
                <span className="flex items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {fmtSAR(branchPrice(offer, listPrice))}
                  </span>
                  <OfferCell offer={offer} state={offerState} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
});
