import { useEffect, useRef, useState } from "react";
import { Ban, Bike, Clock, History, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dutyHoursLabel } from "../normalize";
import { hasActiveFilters, type BranchFilters } from "../search";

/** Is this platform's "command" modifier the Mac one? */
function useIsMac() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent));
  }, []);
  return isMac;
}

function Chip({
  active,
  onClick,
  children,
  count,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
        "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-border/70 bg-card text-foreground/80 hover:border-border hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    >
      {children}
      {count != null && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[10px] tabular-nums",
            active ? "bg-primary-foreground/20" : "bg-muted text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

interface Props {
  filters: BranchFilters;
  resultCount: number;
  totalCount: number;
  cities: { city: string; english: string | null; count: number }[];
  dutyHours: { hours: number; count: number }[];
  favouriteCount: number;
  recent: string[];
  onQueryChange: (value: string) => void;
  onCommitQuery: (value: string) => void;
  onClearRecent: () => void;
  onToggleCity: (city: string) => void;
  onToggleScooter: (value: "yes" | "no") => void;
  onToggleDutyHours: (hours: number) => void;
  onToggleFavourites: () => void;
  onReset: () => void;
}

export function BranchFilterBar({
  filters,
  resultCount,
  totalCount,
  cities,
  dutyHours,
  favouriteCount,
  recent,
  onQueryChange,
  onCommitQuery,
  onClearRecent,
  onToggleCity,
  onToggleScooter,
  onToggleDutyHours,
  onToggleFavourites,
  onReset,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const isMac = useIsMac();
  const active = hasActiveFilters(filters);

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
        setShowRecent(false);
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

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          ref={inputRef}
          value={filters.query}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={() => setShowRecent(true)}
          // Blur is deferred so a click on a recent-search row lands before the
          // list unmounts; mousedown on the row would otherwise be cancelled.
          onBlur={() => window.setTimeout(() => setShowRecent(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommitQuery(filters.query);
              setShowRecent(false);
            }
          }}
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search code, city, address, phone or area manager…"
          aria-label="Search branches"
          className={cn(
            "h-12 w-full rounded-xl border border-border/70 bg-card pl-11 pr-28 text-sm shadow-sm",
            "placeholder:text-muted-foreground/70",
            "transition-[border-color,box-shadow] duration-150",
            "focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20",
            // Safari renders a native clear affordance on type=search that
            // collides with the count badge.
            "[&::-webkit-search-cancel-button]:appearance-none",
          )}
        />

        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
          {filters.query ? (
            <>
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
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
            <kbd className="hidden items-center gap-0.5 rounded border border-border/70 bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground sm:inline-flex">
              {isMac ? "⌘" : "Ctrl"} K
            </kbd>
          )}
        </div>

        {showRecent && recent.length > 0 && filters.query.length === 0 && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex items-center justify-between px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <History className="h-3 w-3" />
                Recent searches
              </span>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onClearRecent}
                className="rounded px-1.5 py-0.5 normal-case tracking-normal hover:bg-accent hover:text-accent-foreground"
              >
                Clear
              </button>
            </div>
            {recent.map((term) => (
              <button
                key={term}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onQueryChange(term);
                  setShowRecent(false);
                  inputRef.current?.focus();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate" dir="auto">
                  {term}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Chips. Horizontally scrollable rather than wrapped: on a phone a wrapped
          set of twelve chips pushes the list below the fold, and the whole
          premise is that results are visible while filtering. */}
      <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
        <Chip active={filters.scooter === "yes"} onClick={() => onToggleScooter("yes")}>
          <Bike className="h-3.5 w-3.5" />
          Scooter
        </Chip>
        <Chip active={filters.scooter === "no"} onClick={() => onToggleScooter("no")}>
          <Ban className="h-3.5 w-3.5" />
          No scooter
        </Chip>

        {favouriteCount > 0 && (
          <Chip active={filters.favouritesOnly} onClick={onToggleFavourites} count={favouriteCount}>
            <Star className={cn("h-3.5 w-3.5", filters.favouritesOnly && "fill-current")} />
            Favourites
          </Chip>
        )}

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />

        {dutyHours.map(({ hours, count }) => (
          <Chip
            key={hours}
            active={filters.dutyHours.includes(hours)}
            onClick={() => onToggleDutyHours(hours)}
            count={count}
          >
            <Clock className="h-3.5 w-3.5" />
            {dutyHoursLabel(hours)}
          </Chip>
        ))}

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />

        {cities.map(({ city, english, count }) => (
          <Chip
            key={city}
            active={filters.cities.includes(city)}
            onClick={() => onToggleCity(city)}
            count={count}
          >
            <span dir="auto">{english ?? city}</span>
          </Chip>
        ))}

        {active && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="ml-1 h-8 shrink-0 text-xs text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Clear all
          </Button>
        )}
      </div>
    </div>
  );
}
