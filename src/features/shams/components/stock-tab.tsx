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
 * so none is shown. A branch either has none — a fact, rendered as a destructive
 * "Out of stock" badge because it is the answer an agent is scanning for — or it
 * has a number, rendered as that number.
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
import { Boxes, Loader2, PackageX, Search, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { filterBranchStock, summariseStock } from "@/lib/shams/search";
import type { ShamsBranchStock, ShamsProduct } from "@/lib/shams/types";
import type { ShamsCrmOffer } from "@/lib/shams-crm/types";
import {
  MIN_QUERY_LENGTH,
  useBranchLabels,
  useDebounced,
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
  selected,
  onSelect,
  query,
  onQueryChange,
}: {
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
  const matches = useMemo(() => searchQuery.data?.products ?? [], [searchQuery.data]);

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
              autoFocus
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

        {searchQuery.isError && <ErrorState onRetry={() => searchQuery.refetch()} />}

        {searchQuery.data && !searchQuery.data.configured && <NotConfiguredState />}

        {searchQuery.data && searchQuery.data.configured && !searchQuery.data.ok && (
          <ErrorState kind={searchQuery.data.error?.kind} onRetry={() => searchQuery.refetch()} />
        )}

        {searchQuery.isFetching && !searchQuery.data && <TableSkeleton rows={4} />}

        {searchQuery.data?.ok && matches.length === 0 && !searchQuery.isFetching && (
          <EmptyState>No products found for “{term.trim()}”.</EmptyState>
        )}

        {matches.length > 0 && (
          <ProductResults
            products={matches}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={onSelect}
            busy={searchQuery.isFetching}
          />
        )}

        {term.trim().length < MIN_QUERY_LENGTH && !searchQuery.isFetching && (
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
        <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Product</p>
            <p className="mt-0.5 text-base font-semibold leading-snug">{selected.itemName}</p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{selected.itemCode}</p>
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
                  than replacing it, so neither number can be read as the other. */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
                <Stat
                  label={filtering ? "matching branches" : "branches"}
                  value={summary.branches}
                />
                <Stat label="in stock" value={summary.withStock} tone="good" />
                <Stat label="out of stock" value={summary.without} tone="muted" />
                <Stat label="units" value={summary.units} />
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
            <StockTable rows={visible} labels={branchLabels} offers={offers} />
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
}: {
  products: ShamsProduct[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (product: ShamsProduct) => void;
  busy: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
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
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                    {p.itemCode}
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

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "good" | "muted";
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "good" && "text-success",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}

/** `P0304` → `Buraydah`, when the portal knows the branch. */
/**
 * One branch's promotional price.
 *
 * `afterOfferPrice` is what the branch charges and `price` is what it was, so the
 * new figure carries the weight and the old one is struck through beside it. The
 * percentage comes from the API preformatted (`offer_display`), so nothing is
 * recomputed here — a discount this component derived could disagree with the
 * one the till applies.
 *
 * Renders nothing at all without an offer. A branch with no promotion shows an
 * em-dash rather than a zero, which would read as "free".
 */
function OfferPrice({ offer }: { offer: ShamsCrmOffer | undefined }) {
  if (!offer) return <span className="text-muted-foreground">—</span>;

  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground line-through tabular-nums">
        {fmtSAR(offer.price)}
      </span>
      <span className="font-semibold tabular-nums">{fmtSAR(offer.afterOfferPrice)}</span>
      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
        {offer.offerDisplay}
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
 * The stock table.
 *
 * Column widths are declared rather than left to the browser: quantity is the
 * column being scanned, so it is pinned narrow and right-aligned against the
 * edge, and the branch column takes the space that used to sit empty in the
 * middle of the row.
 */
const StockTable = memo(function StockTable({
  rows,
  labels,
  offers,
}: {
  rows: ShamsBranchStock[];
  labels: Map<string, BranchLabel> | undefined;
  /** Offer pricing by branch code. Empty when there is none, or none loaded. */
  offers: Map<string, ShamsCrmOffer>;
}) {
  /**
   * The Offer column appears only when a visible row actually has one, so a
   * product without promotions renders the table exactly as before rather than
   * growing a column of dashes.
   */
  const anyOffer = rows.some((row) => offers.has(row.branchCode));

  return (
    <>
      <Card className="hidden overflow-hidden md:block">
        <CardContent className="p-0">
          <table className="w-full table-fixed text-[15px]">
            <colgroup>
              <col className="w-[16%]" />
              <col />
              {anyOffer && <col className="w-[22%]" />}
              <col className="w-[14%]" />
              <col className="w-[20%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className={TH}>Branch</th>
                <th className={TH}>City</th>
                {anyOffer && <th className={cn(TH, "text-right")}>Offer</th>}
                <th className={cn(TH, "text-right")}>Qty</th>
                <th className={cn(TH, "text-right")}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const city = branchCity(labels, row.branchCode);
                const out = row.quantity <= 0;
                return (
                  <tr
                    key={row.branchCode}
                    className="border-b border-border/30 transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <td className={cn(TD, "py-2.5 font-mono font-semibold")}>{row.branchCode}</td>
                    <td className={cn(TD, "truncate py-2.5")} dir="auto">
                      {city ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    {anyOffer && (
                      <td className={cn(TD, "py-2.5 text-right")}>
                        <OfferPrice offer={offers.get(row.branchCode)} />
                      </td>
                    )}
                    <td
                      className={cn(
                        "px-3 py-2.5 text-right text-base font-semibold tabular-nums",
                        out ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {out ? "0" : row.quantity}
                    </td>
                    <td className={cn(TD, "py-2.5 text-right")}>
                      <StockStatus quantity={row.quantity} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Mobile: the same rows as a list, so nothing scrolls sideways. */}
      <Card className="overflow-hidden md:hidden">
        <CardContent className="p-0">
          <ul className="divide-y divide-border/30">
            {rows.map((row) => {
              const city = branchCity(labels, row.branchCode);
              const offer = offers.get(row.branchCode);
              return (
                <li
                  key={row.branchCode}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold">{row.branchCode}</p>
                    <p className="mt-0.5 truncate text-[15px]" dir="auto">
                      {city ?? <span className="text-muted-foreground">—</span>}
                    </p>
                    {offer && (
                      <p className="mt-1">
                        <OfferPrice offer={offer} />
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {row.quantity > 0 && (
                      <span className="text-base font-semibold tabular-nums">{row.quantity}</span>
                    )}
                    <StockStatus quantity={row.quantity} />
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </>
  );
});

/**
 * Whether a branch has the item.
 *
 * Zero is the answer agents are scanning for, so it is destructive-toned and
 * spelled out. A stocked branch gets a quiet success mark rather than a second
 * loud badge — the quantity beside it is the number that matters, and two
 * competing emphases in one row is one too many. No banding between them,
 * because the application defines no "low stock" threshold to band on.
 */
function StockStatus({ quantity }: { quantity: number }) {
  if (quantity <= 0) {
    return (
      <span className="inline-flex whitespace-nowrap rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
        Out of Stock
      </span>
    );
  }
  return (
    <span className="inline-flex whitespace-nowrap rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
      In stock
    </span>
  );
}
