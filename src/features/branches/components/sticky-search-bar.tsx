import { useEffect, useState, type RefObject } from "react";
import { Building2, Crosshair, Loader2, MapPin, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { LocationEntry } from "../location-index";

/**
 * The locator's search, condensed, for when the locator itself has scrolled away.
 *
 * The full panel is not sticky on purpose — expanded it is most of a laptop
 * viewport, and pinning it would permanently spend the space the cards need. But
 * an agent reading a branch card four screens down still has to be able to run
 * the next search without hunting for where the box went. This is that: one line,
 * pinned, carrying the two controls that matter and nothing else.
 *
 * It has two shapes and picks between them on whether the search is *finished*:
 *
 *   - **Nothing chosen yet** — the query and city are still live inputs, because
 *     the agent is mid-search and the likely next action is refining it.
 *   - **A branch is selected** — the search is history, so it reads back as text
 *     with one button to reopen it. Re-editing a search whose answer is already on
 *     screen is the rarer case, and giving it an input would invite typing into a
 *     box whose results are no longer visible.
 */

/** Mirrors the panel's sentinel: a Radix Select item cannot hold "". */
const ANY_CITY = "__any__";

interface Props {
  /** Only meaningful in locator mode; the bar stays hidden otherwise. */
  active: boolean;
  query: string;
  city: string;
  cities: LocationEntry[];
  searching: boolean;
  selected: string | null;
  /**
   * The locator strip. The bar appears exactly when this leaves the viewport.
   *
   * Watched with an IntersectionObserver rather than compared against a scroll
   * offset, because the locator's height changes as it collapses and expands — any
   * fixed pixel threshold would be wrong immediately after either.
   */
  anchorRef: RefObject<HTMLDivElement | null>;
  onQueryChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onSearch: (value: string) => void;
  onChangeSearch: () => void;
}

export function StickySearchBar({
  active,
  query,
  city,
  cities,
  searching,
  selected,
  anchorRef,
  onQueryChange,
  onCityChange,
  onSearch,
  onChangeSearch,
}: Props) {
  const [anchorVisible, setAnchorVisible] = useState(true);

  useEffect(() => {
    const element = anchorRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setAnchorVisible(entry.isIntersecting),
      // Any sliver counts as visible. Showing the compact bar while a strip of the
      // real panel is still on screen would put two search boxes on screen at once.
      { threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchorRef]);

  const show = active && !anchorVisible;
  const cityLabel = city
    ? (cities.find((entry) => entry.name === city)?.english ?? city)
    : "Any city";

  return (
    <div
      // `fixed`, not `sticky`: sticky would need an ancestor tall enough to travel
      // inside, and this has to be able to appear over content it is not a sibling
      // of. Kept out of the accessibility tree and off the tab order while hidden.
      aria-hidden={!show}
      className={cn(
        // Sits below the 4rem app header and to the right of the sidebar, whose
        // current width the layout publishes as --app-sidebar-w.
        "fixed right-0 left-0 top-16 z-20 md:left-[var(--app-sidebar-w)]",
        "border-b border-border/60 bg-background/85 backdrop-blur-md",
        "shadow-sm transition-[opacity,transform] duration-200 ease-out",
        show ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0",
      )}
    >
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-2 sm:px-4 lg:px-6 xl:px-8">

        <Crosshair className="hidden h-4 w-4 shrink-0 text-primary sm:block" aria-hidden />

        {selected ? (
          /* The search, read back. */
          <>
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Search
                </span>
                <span className="truncate text-[13px] font-medium text-foreground" dir="auto">
                  {query.trim() || "—"}
                </span>
              </span>
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  City
                </span>
                <span className="truncate text-[13px] font-medium text-foreground/80" dir="auto">
                  {cityLabel}
                </span>
              </span>
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Branch
                </span>
                <span className="font-mono text-[13px] font-bold text-primary">{selected}</span>
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onChangeSearch}
              tabIndex={show ? 0 : -1}
              className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
            >
              <Search className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Change search</span>
              <span className="sm:hidden">Search</span>
            </Button>
          </>
        ) : (
          /* Still searching: keep the controls live. */
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSearch(query);
            }}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <div className="relative min-w-0 flex-1">
              <MapPin
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                type="search"
                autoComplete="off"
                spellCheck={false}
                placeholder="Customer location…"
                aria-label="Customer location"
                tabIndex={show ? 0 : -1}
                className={cn(
                  "h-8 w-full rounded-md border border-border/70 bg-card pl-8 pr-2 text-[13px] font-medium shadow-sm",
                  "placeholder:font-normal placeholder:text-muted-foreground/70",
                  "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20",
                  "[&::-webkit-search-cancel-button]:appearance-none",
                )}
              />
            </div>

            <Select
              value={city || ANY_CITY}
              onValueChange={(value) => onCityChange(value === ANY_CITY ? "" : value)}
            >
              <SelectTrigger
                aria-label="Limit the search to one city"
                tabIndex={show ? 0 : -1}
                className={cn(
                  "hidden h-8 w-36 shrink-0 gap-1.5 border-border/70 bg-card text-[13px] shadow-sm sm:flex",
                  city && "border-primary/50 font-medium",
                )}
              >
                <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <SelectValue placeholder="Any city" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={ANY_CITY}>Any city</SelectItem>
                {cities.map((entry) => (
                  <SelectItem key={entry.id} value={entry.name}>
                    <span dir="auto">{entry.english ?? entry.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="submit"
              size="sm"
              disabled={searching}
              tabIndex={show ? 0 : -1}
              className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
            >
              {searching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Search className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="hidden sm:inline">Find nearest</span>
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
