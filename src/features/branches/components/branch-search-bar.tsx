import { useEffect, useRef, useState } from "react";
import { Ban, Bike, Clock, History, MapPinned, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dutyHoursLabel } from "../normalize";
import { activeFilterCount, type BranchFilters } from "../search";
import type { BranchView } from "../types";
import { BranchFiltersDrawer } from "./branch-filters-drawer";

/**
 * The page's primary control.
 *
 * Search *is* the workflow here: an agent on a call has a branch code, a phone
 * number or a city in front of them and needs the matching card in one action.
 * So the box gets the width, the height and the focus ring, the filters fold
 * into one button beside it, and everything else on the page is smaller than it.
 *
 * Focusing it while it is empty opens a shortcut panel — recently viewed
 * branches, starred branches, recent searches. Those are the three ways an agent
 * returns to a branch they have already had on screen today, and putting them
 * inside the search overlay rather than on the page costs zero vertical space
 * while the agent is doing anything else.
 */

/** Is this platform's "command" modifier the Mac one? */
function useIsMac() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent));
  }, []);
  return isMac;
}

/** A removable summary of one active filter. */
function Pill({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-1 pl-2.5 pr-1 text-xs font-medium text-foreground">
      <span className="max-w-[12rem] truncate" dir="auto">
        {children}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove filter"
        className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-primary/20 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/** One branch, as a shortcut chip in the focus panel. */
function BranchChip({
  branch,
  onPick,
  starred,
}: {
  branch: BranchView;
  onPick: () => void;
  starred?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      // Spelled out rather than left to the two spans: read as content, this is
      // "P0021 Jeddah", which a screen reader runs together with the star icon
      // and the next chip.
      aria-label={`Show branch ${branch.branch_no} in ${branch.cityEnglish ?? branch.city}`}
      className="inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-accent hover:text-accent-foreground"
    >
      {starred && (
        <Star className="h-3 w-3 shrink-0 fill-current text-[var(--attention)]" aria-hidden />
      )}
      <span className="font-mono text-xs font-semibold">{branch.branch_no}</span>
      <span className="truncate text-[11px] text-muted-foreground" dir="auto">
        {branch.cityEnglish ?? branch.city}
      </span>
    </button>
  );
}

interface Props {
  filters: BranchFilters;
  resultCount: number;
  totalCount: number;
  cities: { city: string; english: string | null; count: number }[];
  managers: { manager: string; count: number }[];
  favourites: ReadonlySet<string>;
  recent: string[];
  recentBranches: string[];
  /** Every branch by code, for resolving the shortcut chips. */
  byCode: ReadonlyMap<string, BranchView>;
  onQueryChange: (value: string) => void;
  onCommitQuery: (value: string) => void;
  onClearRecent: () => void;
  onClearRecentBranches: () => void;
  onToggleCity: (city: string) => void;
  onToggleScooter: (value: "yes" | "no") => void;
  onToggleManager: (manager: string) => void;
  onToggleFavourites: () => void;
  onClearFilters: () => void;
  /** Show one branch, clearing whatever was filtered. */
  onFocusBranch: (branchNo: string) => void;
}

export function BranchSearchBar({
  filters,
  resultCount,
  totalCount,
  cities,
  managers,
  favourites,
  recent,
  recentBranches,
  byCode,
  onQueryChange,
  onCommitQuery,
  onClearRecent,
  onClearRecentBranches,
  onToggleCity,
  onToggleScooter,
  onToggleManager,
  onToggleFavourites,
  onClearFilters,
  onFocusBranch,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const isMac = useIsMac();
  const filterCount = activeFilterCount(filters);

  const recentCards = recentBranches
    .map((code) => byCode.get(code))
    .filter((branch): branch is BranchView => branch != null);
  const favouriteCards = [...favourites]
    .map((code) => byCode.get(code))
    .filter((branch): branch is BranchView => branch != null)
    .slice(0, 8);

  const showPanel =
    panelOpen &&
    filters.query.length === 0 &&
    (recentCards.length > 0 || favouriteCards.length > 0 || recent.length > 0);

  /**
   * Ctrl+K / Cmd+K focuses the search, and Escape leaves it.
   *
   * Bound on the document because the point is to reach the box from anywhere on
   * the page — an agent who just scrolled to a card should be able to start a new
   * search without moving the mouse. The handler bails when focus is already in
   * a text field so it cannot swallow a shortcut someone meant for a form.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.key === "Escape" && document.activeElement === inputRef.current) {
        if (filters.query) onQueryChange("");
        else inputRef.current?.blur();
        setPanelOpen(false);
      }
      if (event.key === "/" && document.activeElement !== inputRef.current) {
        const target = event.target as HTMLElement | null;
        const typing =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable;
        if (typing) return;
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [filters.query, onQueryChange]);

  const pick = (branchNo: string) => {
    onFocusBranch(branchNo);
    setPanelOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        {/* The panel is a sibling of the input inside this wrapper, so focus
            moving from the box to a chip inside it never leaves the wrapper —
            which is how the panel stays open for keyboard users instead of
            closing on a Tab, and closes the moment focus goes anywhere else. */}
        <div
          className="relative min-w-0 flex-1"
          onFocus={() => setPanelOpen(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setPanelOpen(false);
            }
          }}
        >
          <Search
            className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={inputRef}
            value={filters.query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onCommitQuery(filters.query);
                setPanelOpen(false);
              }
            }}
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search a branch code, city, address, phone or area manager…"
            aria-label="Search branches"
            className={cn(
              "h-12 w-full rounded-xl border bg-card pl-12 pr-32 text-sm font-medium shadow-sm sm:text-base",
              "placeholder:font-normal placeholder:text-muted-foreground/70",
              "transition-[border-color,box-shadow] duration-150",
              "border-border/70 hover:border-border",
              "focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15",
              // Safari renders a native clear affordance on type=search that
              // collides with the count badge.
              "[&::-webkit-search-cancel-button]:appearance-none",
            )}
          />

          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            {filters.query ? (
              <>
                <span
                  className="hidden text-xs font-medium tabular-nums text-muted-foreground sm:inline"
                  aria-live="polite"
                >
                  {resultCount} of {totalCount}
                </span>
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    onQueryChange("");
                    inputRef.current?.focus();
                  }}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <kbd className="hidden items-center gap-1 rounded-md border border-border/70 bg-muted px-2 py-1 font-sans text-[11px] font-medium text-muted-foreground sm:inline-flex">
                {isMac ? "⌘" : "Ctrl"} K
              </kbd>
            )}
          </div>

          {showPanel && (
            <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto rounded-xl border border-border/70 bg-popover p-3 shadow-xl animate-in fade-in slide-in-from-top-1 duration-150 [scrollbar-width:thin]">
              {recentCards.length > 0 && (
                <section>
                  <header className="flex items-center justify-between px-1 pb-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <History className="h-3 w-3" />
                      Recently viewed
                    </span>
                    <button
                      type="button"
                      onClick={onClearRecentBranches}
                      className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      Clear
                    </button>
                  </header>
                  <div className="flex flex-wrap gap-1.5">
                    {recentCards.map((branch) => (
                      <BranchChip
                        key={branch.branch_no}
                        branch={branch}
                        onPick={() => pick(branch.branch_no)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {favouriteCards.length > 0 && (
                <section
                  className={cn(recentCards.length > 0 && "mt-3 border-t border-border/50 pt-3")}
                >
                  <header className="px-1 pb-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Star className="h-3 w-3" />
                      Favourites
                    </span>
                  </header>
                  <div className="flex flex-wrap gap-1.5">
                    {favouriteCards.map((branch) => (
                      <BranchChip
                        key={branch.branch_no}
                        branch={branch}
                        starred
                        onPick={() => pick(branch.branch_no)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {recent.length > 0 && (
                <section
                  className={cn(
                    (recentCards.length > 0 || favouriteCards.length > 0) &&
                      "mt-3 border-t border-border/50 pt-3",
                  )}
                >
                  <header className="flex items-center justify-between px-1 pb-1">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Search className="h-3 w-3" />
                      Recent searches
                    </span>
                    <button
                      type="button"
                      onClick={onClearRecent}
                      className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      Clear
                    </button>
                  </header>
                  {recent.map((term) => (
                    <button
                      key={term}
                      type="button"
                      onClick={() => {
                        onQueryChange(term);
                        setPanelOpen(false);
                        inputRef.current?.focus();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate" dir="auto">
                        {term}
                      </span>
                    </button>
                  ))}
                </section>
              )}
            </div>
          )}
        </div>

        <BranchFiltersDrawer
          filters={filters}
          resultCount={resultCount}
          cities={cities}
          managers={managers}
          favouriteCount={favourites.size}
          onToggleCity={onToggleCity}
          onToggleScooter={onToggleScooter}
          onToggleManager={onToggleManager}
          onToggleFavourites={onToggleFavourites}
        />

        {/* Clearing filters is one click from the top of the page, not two from
            inside a drawer. Shown only when there is something to clear, so it
            never sits there greyed out taking up the space. */}
        {filterCount > 0 && (
          <Button
            variant="ghost"
            onClick={onClearFilters}
            title="Clear all filters"
            className="h-12 shrink-0 gap-1.5 px-3 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        )}
      </div>

      {/* Active filters, in one scrollable line. The drawer hides *how* the list
          is narrowed; without this, a filter left on from an earlier call is
          invisible and every count on the page looks wrong. */}
      {filterCount > 0 && (
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:thin]">
          {filters.scooter !== "any" && (
            <Pill onRemove={() => onToggleScooter(filters.scooter as "yes" | "no")}>
              <span className="inline-flex items-center gap-1">
                {filters.scooter === "yes" ? (
                  <Bike className="h-3 w-3" />
                ) : (
                  <Ban className="h-3 w-3" />
                )}
                {filters.scooter === "yes" ? "Scooter" : "No scooter"}
              </span>
            </Pill>
          )}
          {filters.favouritesOnly && (
            <Pill onRemove={onToggleFavourites}>
              <span className="inline-flex items-center gap-1">
                <Star className="h-3 w-3 fill-current" />
                Favourites
              </span>
            </Pill>
          )}
          {filters.cities.map((city) => (
            <Pill key={city} onRemove={() => onToggleCity(city)}>
              <span className="inline-flex items-center gap-1">
                <MapPinned className="h-3 w-3" />
                {cities.find((entry) => entry.city === city)?.english ?? city}
              </span>
            </Pill>
          ))}
          {filters.managers.map((manager) => (
            <Pill key={manager} onRemove={() => onToggleManager(manager)}>
              {manager}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}
