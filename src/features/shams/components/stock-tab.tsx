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

import { memo, useDeferredValue, useMemo, useState } from "react";
import { Boxes, PackageX, Search, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { filterBranchStock, summariseStock } from "@/lib/shams/search";
import type { ShamsBranchStock, ShamsProduct } from "@/lib/shams/types";
import {
  MIN_QUERY_LENGTH,
  useBranchLabels,
  useDebounced,
  useProductDetail,
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
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
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
}: {
  selected: ShamsProduct | null;
  onSelect: (product: ShamsProduct | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const term = useDebounced(draft);

  // The picker only runs while no product is chosen — once one is, this tab is
  // about its stock, and there is nothing to search for.
  const searchQuery = useProductSearch(term, !selected);
  const matches = searchQuery.data?.products ?? [];

  const stockQuery = useProductDetail(selected?.itemCode ?? null, Boolean(selected));
  const result = stockQuery.data;
  const stock = useMemo(() => result?.stock ?? [], [result]);

  const { data: branchLabels } = useBranchLabels();

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
              onChange={setDraft}
              placeholder="Search a product — try mou*n*j*2.5"
              autoFocus
            />
            <p className="mt-2 text-xs leading-snug text-muted-foreground">
              Type any part of a name or item code.{" "}
              <span className="font-medium text-foreground">*</span> stands for anything in between,
              so <span className="font-mono">mou*n*j*2.5</span> finds Mounjaro 2.5.
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
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <ul className="divide-y divide-border/40">
                {matches.map((p) => (
                  <li key={p.itemCode}>
                    <button
                      type="button"
                      onClick={() => onSelect(p)}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none"
                    >
                      <span className="min-w-0">
                        {/* The full name carries strength and pack size — the
                            catalog exposes no separate field for either, so it
                            is never truncated. */}
                        <span className="block text-sm font-medium leading-snug">{p.itemName}</span>
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
                  placeholder="Filter branches — code, city or area"
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

              {/* Counts for what is on screen. When a filter is active the
                  chain-wide figure is kept beside it rather than replaced, so
                  neither number can be mistaken for the other. */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
                <Stat label="Branches" value={summary.branches} />
                <Stat label="In stock" value={summary.withStock} tone="good" />
                <Stat label="Out of stock" value={summary.without} tone="muted" />
                <Stat label="Units" value={summary.units} />
                {filtering && (
                  <span className="text-xs text-muted-foreground">
                    filtered from {totalSummary.branches} branches ·{" "}
                    <span className="tabular-nums">{totalSummary.withStock}</span> in stock ·{" "}
                    <span className="tabular-nums">{totalSummary.units}</span> units
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {visible.length === 0 ? (
            <EmptyState>No branch matches “{deferredFilter.trim()}”.</EmptyState>
          ) : (
            <StockTable rows={visible} labels={branchLabels} />
          )}
        </>
      )}
    </div>
  );
}

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
}: {
  rows: ShamsBranchStock[];
  labels: Map<string, BranchLabel> | undefined;
}) {
  return (
    <>
      <Card className="hidden overflow-hidden md:block">
        <CardContent className="p-0">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[22%]" />
              <col />
              <col className="w-[22%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className={TH}>Branch</th>
                <th className={TH}>City</th>
                <th className={TH}>Area</th>
                <th className={cn(TH, "text-right")}>Quantity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const city = branchCity(labels, row.branchCode);
                return (
                  <tr
                    key={row.branchCode}
                    className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <td className={cn(TD, "py-2.5 font-mono text-sm font-semibold")}>
                      {row.branchCode}
                    </td>
                    <td className={cn(TD, "py-2.5 truncate font-medium")} dir="auto">
                      {city ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className={cn(TD, "py-2.5 truncate text-xs text-muted-foreground")}>
                      {row.areaName || "—"}
                    </td>
                    <td className={cn(TD, "py-2.5 text-right")}>
                      <QuantityCell quantity={row.quantity} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Mobile: the same rows as cards, so nothing scrolls sideways. */}
      <Card className="overflow-hidden md:hidden">
        <CardContent className="p-0">
          <ul className="divide-y divide-border/40">
            {rows.map((row) => {
              const city = branchCity(labels, row.branchCode);
              return (
                <li
                  key={row.branchCode}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold">{row.branchCode}</p>
                    <p className="mt-0.5 truncate text-sm" dir="auto">
                      {city ?? <span className="text-muted-foreground">—</span>}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {row.areaName || ""}
                      </span>
                    </p>
                  </div>
                  <QuantityCell quantity={row.quantity} />
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
 * A quantity, or the fact that there is none.
 *
 * Zero is the answer agents are scanning for, so it is destructive-toned and
 * spelled out rather than shown as a `0` among numbers. Every positive value is
 * shown as itself — no banding, because the application defines no threshold to
 * band on.
 */
function QuantityCell({ quantity }: { quantity: number }) {
  if (quantity <= 0) {
    return (
      <span className="inline-flex whitespace-nowrap rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
        Out of Stock
      </span>
    );
  }
  return (
    <span className="inline-flex whitespace-nowrap rounded-full bg-success/10 px-2.5 py-1 text-sm font-semibold tabular-nums text-success">
      {quantity}
    </span>
  );
}
