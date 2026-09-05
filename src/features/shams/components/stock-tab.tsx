/**
 * Branch Stock — find a product, then read its availability per branch.
 *
 * This is the whole catalog experience since the standalone Products tab was
 * removed: the same `product/search` lookup starts here, and choosing a result
 * loads the stock the agent came for. One screen, one flow, one request per
 * step.
 *
 * Three decisions worth stating.
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
 * **Branch names come from MilaServ.** The MIS returns `branchName` identical to
 * `branchCode` on every row, so it is not a display name. Discovery established
 * that `branchCode` is the same identifier as `branches.branch_no`, so the
 * portal's own directory supplies the city. A code the portal does not know
 * still renders, with its code alone, rather than being dropped.
 *
 * **The summary is computed from the rows on screen.** Filtering to "Jeddah"
 * recomputes it, because a total that disagrees with the table under it is worse
 * than no total at all. The unfiltered figure stays visible alongside, so the
 * agent can still see the chain-wide picture.
 */

import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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
   */
  const offersQuery = useProductOffers(selected?.itemCode ?? null);
  const offers = useMemo(() => {
    const rows = offersQuery.data?.ok ? offersQuery.data.offers : [];
    return new Map(rows.map((offer) => [offer.branchCode, offer]));
  }, [offersQuery.data]);
  /** Coverage for the opened product, from the same response as `offers`. */
  const openScope = offersQuery.data?.ok ? offersQuery.data.scope : null;

  /**
   * Offer coverage for the products in the result list.
   *
   * So an agent can see which results are on promotion *before* opening one —
   * previously the only way to find out was to open each in turn.
   *
   * `!selected` is doing real work: once a product is open the result list is
   * gone, but its query data is still cached, so without this the tab would
   * keep asking about a list nobody is looking at.
   */
  const resultCodes = useMemo(() => matches.map((p) => p.itemCode), [matches]);
  const scopes = useOfferScopes(resultCodes, !selected);

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
            onSelect={onSelect}
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
      <Card>
        {/* Deliberately tight. This is a context bar naming what the table
            below is about, not a product card — the branch data is the content
            of this screen, and the header should cost as little vertical space
            as it can while still being unambiguous. */}
        <CardContent className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Product
            </p>
            <p className="mt-1 text-[15px] font-semibold leading-snug">{selected.itemName}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-xs text-muted-foreground">{selected.itemCode}</span>
              {/* Spelled out here and only here — the rows below carry the bare
                  percentage. Same response as the per-branch prices, so the
                  summary and the detail cannot tell an agent two different
                  things. */}
              <OfferScopeBadge scope={openScope ?? undefined} variant="summary" />
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setBranchFilter("");
              onSelect(null);
            }}
            className="shrink-0 rounded-md border border-border/70 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted focus:bg-muted focus:outline-none"
          >
            Change product
          </button>
        </CardContent>
      </Card>

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
            <CardContent className="space-y-3 p-3 sm:p-4">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  placeholder="Filter branches — code or city"
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

              {/* Counts for what is on screen, always. When a filter is active
                  it says so, and the chain-wide figure is kept beside it rather
                  than replacing it, so neither number can be read as the other.

                  One strip divided into four, rather than four separate
                  surfaces: these are parts of a single answer about one product,
                  and boxing each one implies they are independent readings.
                  `divide-x` carries the separation at a fraction of the weight a
                  border-plus-shadow would. */}
              <div className="grid grid-cols-2 divide-x divide-y divide-border/60 border-y border-border/60 sm:grid-cols-4 sm:divide-y-0 sm:border-y-0 sm:border-t sm:pt-1">
                <Kpi
                  label={filtering ? "Matching branches" : "Branches"}
                  value={summary.branches}
                />
                <Kpi label="In stock" value={summary.withStock} tone="good" />
                <Kpi label="Out of stock" value={summary.without} tone="muted" />
                <Kpi label="Total units" value={summary.units} />
              </div>
              {filtering && (
                <p className="text-xs text-muted-foreground">
                  Summary is for the filtered results. All branches:{" "}
                  <span className="tabular-nums">{totalSummary.branches}</span> branches ·{" "}
                  <span className="tabular-nums">{totalSummary.withStock}</span> in stock ·{" "}
                  <span className="tabular-nums">{totalSummary.units}</span> units.
                </p>
              )}
            </CardContent>
          </Card>

          {visible.length === 0 ? (
            <EmptyState>No branch matches “{deferredFilter.trim()}”.</EmptyState>
          ) : (
            <BranchStockTable rows={visible} labels={branchLabels} offers={offers} />
          )}
        </>
      )}
    </div>
  );
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
function OfferScopeBadge({
  scope,
  /**
   * `summary` spells the coverage out for the one place it is stated about the
   * product as a whole; `compact` is the chip a row carries. Same classified
   * `kind` behind both — the wording differs, the claim does not.
   */
  variant = "compact",
}: {
  scope: ShamsOfferScope | undefined;
  variant?: "compact" | "summary";
}) {
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
      <span className="font-medium opacity-80">
        {variant === "summary"
          ? all
            ? "· Available in all branches"
            : "· Available in some branches"
          : all
            ? "· all branches"
            : "· some branches"}
      </span>
    </span>
  );
}

/**
 * One figure in the summary strip.
 *
 * Number over label, not number beside it: four inline pairs read as a
 * sentence, and this is a row of independent measures an operator scans down
 * rather than across. Restrained on purpose — the figure is set large enough to
 * find and no larger, with no card, no shadow and no icon, because four of
 * these sitting in a bordered strip is an inventory summary and four of them in
 * boxes is a marketing dashboard.
 */
function Kpi({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "good" | "muted";
}) {
  return (
    <div className="min-w-0 px-3 py-2 first:pl-0 sm:px-4">
      <p
        className={cn(
          "text-xl font-semibold leading-none tabular-nums sm:text-2xl",
          tone === "good" && "text-success",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </p>
      <p className="mt-1.5 truncate text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

/** `P0304` → `Buraydah`, when the portal knows the branch. */
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

function branchCity(labels: Map<string, BranchLabel> | undefined, code: string): string | null {
  const hit = labels?.get(code);
  if (!hit) return null;
  return hit.cityEnglish ?? hit.city ?? null;
}

/**
 * Branch availability, as an operational table.
 *
 * ## What this is for
 *
 * One product, up to ~140 branches, and an operator answering "who has it and
 * is it discounted there". That is a register, and a register is read by
 * scanning one column at a time — so the layout that serves it is a dense table
 * with fixed columns, not a surface per branch. A card grid turns 140 rows into
 * 140 bordered boxes and roughly five screens of scrolling, and it makes the
 * page read like a storefront rather than an inventory system.
 *
 * ## The density rules
 *
 * - **Rows separate, cells do not.** A hairline between rows is enough to keep
 *   the eye on one line; ruling every cell would draw a grid the data does not
 *   need.
 * - **The branch code is the strongest thing in the row**, because it is the
 *   identifier the rest of the portal joins on.
 * - **Stock is right-aligned and tabular**, so a column of quantities lines up
 *   on the decimal and can be compared without reading.
 * - **Colour is reserved.** It appears on availability and on an offer, and
 *   nowhere else — a row is never tinted as a whole, so the two things that do
 *   carry colour keep their meaning.
 * - **The offer cell is quiet when empty.** Most branches will have no
 *   promotion, and a column of dashes is noise; the cell simply stays blank.
 *
 * ## Small screens
 *
 * The table is replaced, not scrolled. Five columns cannot be honest at 375px,
 * and a sideways-scrolling table hides the offer column exactly where it
 * matters. Below `md` the same rows render as a dense two-line list — branch
 * and city, then stock, availability and offer — so nothing is lost and the
 * page itself never scrolls horizontally.
 *
 * Still no invented thresholds. A branch has a number or it has none.
 */
const BranchStockTable = memo(function BranchStockTable({
  rows,
  labels,
  offers,
}: {
  rows: ShamsBranchStock[];
  labels: Map<string, BranchLabel> | undefined;
  /** Offer pricing by branch code. Empty when there is none, or none loaded. */
  offers: Map<string, ShamsCrmOffer>;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* Desktop: the register. */}
        <table className="hidden w-full table-fixed text-sm md:table">
          <colgroup>
            <col className="w-[14%]" />
            <col />
            <col className="w-[10%]" />
            <col className="w-[16%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/60 bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className={TH}>Branch</th>
              <th className={TH}>City</th>
              <th className={cn(TH, "text-right")}>Stock</th>
              <th className={TH}>Availability</th>
              <th className={TH}>Offer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const city = branchCity(labels, row.branchCode);
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
                  <td className={cn(TD, "truncate py-2")} dir="auto" title={city ?? undefined}>
                    {city ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right text-[15px] font-semibold tabular-nums",
                      out ? "text-muted-foreground/60" : "text-foreground",
                    )}
                  >
                    {out ? "0" : row.quantity}
                  </td>
                  <td className={cn(TD, "py-2")}>
                    <StockStatus quantity={row.quantity} />
                  </td>
                  <td className={cn(TD, "py-2")}>
                    {/* Blank rather than an em-dash: most branches have no
                        promotion, and a column of dashes reads as data. */}
                    {offer ? <OfferPrice offer={offer} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Mobile: the same rows, two lines each. No sideways scrolling. */}
        <ul className="divide-y divide-border/40 md:hidden">
          {rows.map((row) => {
            const city = branchCity(labels, row.branchCode);
            const offer = offers.get(row.branchCode);
            const out = row.quantity <= 0;
            return (
              <li key={row.branchCode} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex items-baseline gap-2">
                    <span className="font-mono text-[13px] font-semibold">{row.branchCode}</span>
                    <span className="truncate text-sm text-muted-foreground" dir="auto">
                      {city ?? "—"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[15px] font-semibold tabular-nums",
                      out ? "text-muted-foreground/60" : "text-foreground",
                    )}
                  >
                    {out ? "0" : row.quantity}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StockStatus quantity={row.quantity} />
                  {offer && <OfferPrice offer={offer} />}
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
