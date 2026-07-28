import { useCallback, useEffect, useState } from "react";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useColumnCount, useVirtualRows } from "../hooks/use-virtual-rows";
import type { BranchView } from "../types";
import { BranchCard, BranchCardSkeleton, CARD_HEIGHT, CARD_MIN_WIDTH } from "./branch-card";

const GAP = 12;

interface Props {
  branches: BranchView[];
  loading: boolean;
  selected: string | null;
  favourites: ReadonlySet<string>;
  /** Folded query tokens, passed down so cards can highlight what matched. */
  tokens: readonly string[];
  /** What is typed, verbatim — the empty state quotes it back. */
  query: string;
  /** Whether this user may correct a branch in place. */
  canEdit?: boolean;
  onSelect: (branchNo: string | null) => void;
  onToggleFavourite: (branchNo: string) => void;
  onEdit?: (branch: BranchView) => void;
  onResetFilters: () => void;
  onClearSearch: () => void;
  filtered: boolean;
  className?: string;
}

export function BranchList({
  branches,
  loading,
  selected,
  favourites,
  tokens,
  query,
  canEdit,
  onSelect,
  onToggleFavourite,
  onEdit,
  onResetFilters,
  onClearSearch,
  filtered,
  className,
}: Props) {
  const { gridRef, columns } = useColumnCount(CARD_MIN_WIDTH);

  // Every card is the same height now that none of them expands, so the
  // virtualizer's variable-row support goes unused: no index is taller, and
  // nothing adds to it.
  const { scrollRef, totalHeight, rows, scrollToIndex } = useVirtualRows({
    count: branches.length,
    itemsPerRow: columns,
    rowHeight: CARD_HEIGHT,
    gap: GAP,
    expandedIndex: null,
    expandedExtra: 0,
  });

  /**
   * Bring a branch selected on the map into view in the list.
   *
   * Guarded on the row being off screen so that clicking down a visible list of
   * results does not yank the scroll position out from under the pointer.
   */
  useEffect(() => {
    if (!selected) return;
    const index = branches.findIndex((branch) => branch.branch_no === selected);
    if (index < 0) return;
    const visible = rows.some((row) => row.index === Math.floor(index / Math.max(1, columns)));
    if (!visible) scrollToIndex(index);
    // Reacting to `rows` would re-run this on every scroll frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, branches, columns, scrollToIndex]);

  if (loading) {
    return (
      <div className={cn("overflow-hidden", className)}>
        {/* Measured too, so the skeletons come up in the same number of columns
            the real cards will, and the first paint of the list is not a
            re-flow. */}
        <div
          ref={gridRef}
          className="grid gap-3 p-0.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <BranchCardSkeleton key={index} />
          ))}
        </div>
      </div>
    );
  }

  if (branches.length === 0) {
    const searched = query.trim().length > 0;
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-card/50 px-6 py-16 text-center",
          className,
        )}
      >
        <span className="grid h-12 w-12 place-items-center rounded-full bg-muted" aria-hidden>
          <SearchX className="h-6 w-6 text-muted-foreground/70" />
        </span>
        <p className="mt-3 text-sm font-medium text-foreground">
          {searched ? (
            <>
              Nothing matches{" "}
              <span className="font-semibold" dir="auto">
                “{query.trim()}”
              </span>
            </>
          ) : filtered ? (
            "No branches match these filters"
          ) : (
            "The directory is empty"
          )}
        </p>
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">
          {filtered
            ? "A branch code, city, address, phone number or area manager name will all find a branch. Try fewer words, or drop a filter."
            : "An administrator can populate it from the import page."}
        </p>
        {filtered && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {searched && (
              <Button variant="outline" size="sm" onClick={onClearSearch}>
                Clear search
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onResetFilters}>
              Reset everything
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        "overflow-y-auto overscroll-contain [scrollbar-width:thin]",
        // Room for the last card's shadow.
        "pb-4",
        className,
      )}
    >
      <div ref={gridRef} className="relative px-0.5" style={{ height: totalHeight }}>
        {rows.map((row) => {
          const first = row.index * columns;
          const items = branches.slice(first, first + columns);
          return (
            <div
              key={row.index}
              className="absolute inset-x-0 grid items-start gap-3 px-0.5"
              style={{
                transform: `translateY(${row.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {items.map((branch) => (
                <BranchCard
                  key={branch.branch_no}
                  branch={branch}
                  selected={branch.branch_no === selected}
                  favourite={favourites.has(branch.branch_no)}
                  tokens={tokens}
                  canEdit={canEdit}
                  onSelect={onSelect}
                  onToggleFavourite={onToggleFavourite}
                  onEdit={onEdit}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
