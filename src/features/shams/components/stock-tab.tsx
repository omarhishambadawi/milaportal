/**
 * Branch Stock — availability for one product, per branch.
 *
 * Two decisions worth stating.
 *
 * **No invented thresholds.** The brief allows an "Available / Low / Out of
 * stock" treatment only if the application already defines what "low" means. It
 * does not — there is no stock threshold anywhere in this codebase — so none is
 * invented. A branch either has none (which is a fact, not a judgement, and is
 * shown as "Out of stock") or it has a number, shown as that number. Making up
 * a "low" boundary would put an operational signal on screen that no one at the
 * pharmacy agreed to.
 *
 * **Branch names come from MilaServ.** The MIS returns `branchName` identical
 * to `branchCode` on every row, so it is not a display name. Discovery
 * established that `branchCode` is the same identifier as `branches.branch_no`,
 * so the portal's own directory supplies the city label. A code the portal does
 * not know still renders — with its code alone — rather than being dropped.
 */

import { memo, useMemo, useState } from "react";
import { Boxes, PackageX } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ShamsBranchStock, ShamsProduct } from "@/lib/shams/types";
import {
  MIN_QUERY_LENGTH,
  useBranchLabels,
  useDebounced,
  useProductDetail,
  useProductSearch,
  type BranchLabel,
} from "@/features/shams/hooks/use-shams-data";
import { ProductSearchField } from "./products-tab";
import { TD, TH } from "@/features/shams/constants";
import { EmptyState, ErrorState, NotConfiguredState, TableSkeleton } from "./states";

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

  const summary = useMemo(() => {
    const withStock = stock.filter((row) => row.quantity > 0).length;
    return { total: stock.length, withStock, without: stock.length - withStock };
  }, [stock]);

  if (!selected) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="p-4">
            <ProductSearchField
              value={draft}
              onChange={setDraft}
              placeholder="Find a product to check stock…"
            />
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              Pick a product to load its branch stock. Stock is never loaded for a whole result
              list.
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
          <Card>
            <CardContent className="p-2">
              <ul className="divide-y divide-border/40">
                {matches.map((p) => (
                  <li key={p.itemCode}>
                    <button
                      type="button"
                      onClick={() => onSelect(p)}
                      className="w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
                    >
                      <p className="text-sm font-medium leading-snug">{p.itemName}</p>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">{p.itemCode}</p>
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
            <p className="mt-0.5 text-sm font-semibold leading-snug">{selected.itemName}</p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{selected.itemCode}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDraft("");
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
          <div className="grid grid-cols-3 gap-3">
            <SummaryTile label="Branches" value={summary.total} />
            <SummaryTile label="With stock" value={summary.withStock} tone="good" />
            <SummaryTile label="Out of stock" value={summary.without} tone="muted" />
          </div>
          <StockTable rows={stock} labels={branchLabels} />
        </>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "good" | "muted";
}) {
  return (
    <Card>
      <CardContent className="p-3 sm:p-4">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn(
            "mt-0.5 text-xl font-semibold tabular-nums sm:text-2xl",
            tone === "good" && "text-success",
            tone === "muted" && "text-muted-foreground",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

/** `P0304` → `P0304 · Buraydah`, when the portal knows the branch. */
function branchCity(labels: Map<string, BranchLabel> | undefined, code: string): string | null {
  const hit = labels?.get(code);
  if (!hit) return null;
  return hit.cityEnglish ?? hit.city ?? null;
}

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
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className={TH}>Branch</th>
                <th className={TH}>Area</th>
                <th className={cn(TH, "text-right")}>Quantity</th>
                <th className={cn(TH, "text-right")}>LZ Quantity</th>
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
                    <td className={TD}>
                      <span className="font-mono text-xs font-semibold">{row.branchCode}</span>
                      {city && <span className="ml-2 text-muted-foreground">{city}</span>}
                    </td>
                    <td className={cn(TD, "text-muted-foreground")}>{row.areaName || "—"}</td>
                    <td className={cn(TD, "text-right")}>
                      <QuantityCell quantity={row.quantity} />
                    </td>
                    <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>
                      {row.lzQuantity}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="space-y-2 md:hidden">
        {rows.map((row) => {
          const city = branchCity(labels, row.branchCode);
          return (
            <Card key={row.branchCode}>
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-semibold">{row.branchCode}</p>
                  <p className="mt-0.5 truncate text-sm">
                    {city ?? <span className="text-muted-foreground">—</span>}
                  </p>
                  <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {row.areaName || "—"} · LZ {row.lzQuantity}
                  </p>
                </div>
                <QuantityCell quantity={row.quantity} />
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
});

/**
 * A quantity, or the fact that there is none.
 *
 * Zero gets a label because "Out of stock" is what zero *means* and is quicker
 * to scan than a 0 among numbers. Every non-zero value is shown as itself — no
 * banding, because the application defines no threshold to band on.
 */
function QuantityCell({ quantity }: { quantity: number }) {
  if (quantity <= 0) {
    return (
      <span className="inline-flex whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        Out of stock
      </span>
    );
  }
  return (
    <span className="inline-flex whitespace-nowrap rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-success">
      {quantity}
    </span>
  );
}
