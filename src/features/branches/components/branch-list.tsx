import { useCallback, useEffect, useRef, useState } from "react";
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
  onSelect: (branchNo: string | null) => void;
  onToggleFavourite: (branchNo: string) => void;
  onResetFilters: () => void;
  filtered: boolean;
  className?: string;
}

export function BranchList({
  branches,
  loading,
  selected,
  favourites,
  onSelect,
  onToggleFavourite,
  onResetFilters,
  filtered,
  className,
}: Props) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const columns = useColumnCount(gridRef, CARD_MIN_WIDTH);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedExtra, setExpandedExtra] = useState(0);

  /**
   * One card open at a time.
   *
   * Not a stylistic preference: the virtualizer models exactly one variable-height
   * row (see `useVirtualRows`), which is what lets every other row position be
   * arithmetic. Allowing two open cards would mean measuring every row.
   */
  const toggleExpand = useCallback((branchNo: string) => {
    setExpanded((current) => (current === branchNo ? null : branchNo));
  }, []);

  const expandedIndex = expanded
    ? branches.findIndex((branch) => branch.branch_no === expanded)
    : -1;

  // A card that scrolls out of the filtered set takes its expansion with it —
  // otherwise the layout reserves space for a panel nobody can see.
  useEffect(() => {
    if (expanded && expandedIndex === -1) {
      setExpanded(null);
      setExpandedExtra(0);
    }
  }, [expanded, expandedIndex]);

  const { scrollRef, totalHeight, rows, scrollToIndex } = useVirtualRows({
    count: branches.length,
    itemsPerRow: columns,
    rowHeight: CARD_HEIGHT,
    gap: GAP,
    expandedIndex: expandedIndex >= 0 ? expandedIndex : null,
    expandedExtra,
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

  const onMeasureExpanded = useCallback((height: number) => setExpandedExtra(height), []);

  if (loading) {
    return (
      <div className={cn("overflow-hidden", className)}>
        <div
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
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-card/50 px-6 py-16 text-center",
          className,
        )}
      >
        <SearchX className="h-10 w-10 text-muted-foreground/50" aria-hidden />
        <p className="mt-3 text-sm font-medium text-foreground">No branches match</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {filtered
            ? "Try a shorter search, or clear a filter or two — a branch code, city, phone number or area manager name will all find it."
            : "The directory is empty. An administrator can populate it from the import page."}
        </p>
        {filtered && (
          <Button variant="outline" size="sm" className="mt-4" onClick={onResetFilters}>
            Clear filters
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        "overflow-y-auto overscroll-contain [scrollbar-width:thin]",
        // Room for the last card's shadow, and for the expanded panel of a card
        // opened at the very bottom.
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
                  expanded={branch.branch_no === expanded}
                  selected={branch.branch_no === selected}
                  favourite={favourites.has(branch.branch_no)}
                  onToggleExpand={toggleExpand}
                  onSelect={onSelect}
                  onToggleFavourite={onToggleFavourite}
                  onMeasureExpanded={branch.branch_no === expanded ? onMeasureExpanded : undefined}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
