import { useMemo, useState } from "react";
import { Ban, Bike, Check, ChevronDown, MapPinned, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { foldText } from "../normalize";
import { activeFilterCount, type BranchFilters } from "../search";

/**
 * Every filter, on one line, each behind its own dropdown.
 *
 * This replaces a right-hand drawer holding all five groups at once. The drawer
 * was itself a replacement for a chip bar, and it fixed the chip bar's problem
 * (two permanent lines of a viewport-height page) by creating a worse one: with
 * everything behind a single "Filters" button, the only thing telling an agent
 * *what* was narrowing their list was a numeric badge, so a second row of
 * removable pills had to be added below the search box to say what the badge
 * meant. Two surfaces, both permanent, to describe one set of choices.
 *
 * A dropdown per group says it in one place. The trigger names the group when
 * nothing is chosen and names the choice when something is, so the bar reads
 * "City: Riyadh +2 · Delivery: Scooter" without a pill row underneath — and the
 * whole thing is one 32px line instead of a 48px button plus a 32px pill strip.
 *
 * Popovers rather than a sheet because each group is now small enough to be one:
 * the sheet existed to hold five groups at once, and no single group here is
 * more than a scrollable list of names.
 */

/** A checkable row inside one of the dropdowns. */
function Row({
  active,
  onClick,
  children,
  count,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
  icon?: typeof Star;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="checkbox"
      aria-checked={active}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
        "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active ? "bg-primary/10 text-foreground" : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
          active ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {active && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />}
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {children}
      </span>
      {count != null && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  );
}

/**
 * One dropdown.
 *
 * `summary` is what makes this bar self-describing: it is the chosen value when
 * there is one, so the closed trigger carries the same information the removable
 * pill used to, in the control that changes it.
 */
function FilterMenu({
  label,
  summary,
  count,
  icon: Icon,
  children,
  align = "start",
}: {
  label: string;
  summary?: string | null;
  count: number;
  icon: typeof Star;
  children: React.ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const active = count > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={active ? `${label}: ${summary}` : `Filter by ${label.toLowerCase()}`}
          className={cn(
            "inline-flex h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium",
            "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            active
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border/70 bg-card text-muted-foreground hover:border-border hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate" dir="auto">
            {active ? summary : label}
          </span>
          <ChevronDown
            className={cn("h-3 w-3 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-1.5">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** "Riyadh" for one, "Riyadh +2" for several. */
function summarise(values: string[], render: (value: string) => string): string | null {
  if (values.length === 0) return null;
  const first = render(values[0]);
  return values.length === 1 ? first : `${first} +${values.length - 1}`;
}

interface Props {
  filters: BranchFilters;
  cities: { city: string; english: string | null; count: number }[];
  managers: { manager: string; count: number }[];
  favouriteCount: number;
  onToggleCity: (city: string) => void;
  onToggleScooter: (value: "yes" | "no") => void;
  onToggleManager: (manager: string) => void;
  onToggleFavourites: () => void;
  onClearFilters: () => void;
}

export function BranchFilterBar({
  filters,
  cities,
  managers,
  favouriteCount,
  onToggleCity,
  onToggleScooter,
  onToggleManager,
  onToggleFavourites,
  onClearFilters,
}: Props) {
  const [cityQuery, setCityQuery] = useState("");
  const [managerQuery, setManagerQuery] = useState("");
  const total = activeFilterCount(filters);

  // Both lists are people-or-place names, and a list of names is one you scan
  // for something you already have in mind. Filtering keeps them usable as the
  // network grows past a screenful.
  const visibleCities = useMemo(() => {
    const needle = foldText(cityQuery);
    if (!needle) return cities;
    return cities.filter(
      (entry) =>
        foldText(entry.city).includes(needle) || foldText(entry.english ?? "").includes(needle),
    );
  }, [cities, cityQuery]);

  const visibleManagers = useMemo(() => {
    const needle = foldText(managerQuery);
    if (!needle) return managers;
    return managers.filter((entry) => foldText(entry.manager).includes(needle));
  }, [managers, managerQuery]);

  const cityLabel = (city: string) => cities.find((entry) => entry.city === city)?.english ?? city;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {cities.length > 0 && (
        <FilterMenu
          label="City"
          icon={MapPinned}
          count={filters.cities.length}
          summary={summarise(filters.cities, cityLabel)}
        >
          <SearchBox value={cityQuery} onChange={setCityQuery} placeholder="Find a city…" />
          <div className="max-h-64 space-y-0.5 overflow-y-auto [scrollbar-width:thin]">
            {visibleCities.map(({ city, english, count }) => (
              <Row
                key={city}
                active={filters.cities.includes(city)}
                onClick={() => onToggleCity(city)}
                count={count}
              >
                {english ? `${english} · ${city}` : city}
              </Row>
            ))}
            {visibleCities.length === 0 && <Empty>No city by that name.</Empty>}
          </div>
        </FilterMenu>
      )}

      <FilterMenu
        label="Delivery"
        icon={Bike}
        count={filters.scooter === "any" ? 0 : 1}
        summary={filters.scooter === "yes" ? "Scooter" : "No scooter"}
      >
        <Row active={filters.scooter === "yes"} onClick={() => onToggleScooter("yes")} icon={Bike}>
          Scooter available
        </Row>
        <Row active={filters.scooter === "no"} onClick={() => onToggleScooter("no")} icon={Ban}>
          No scooter
        </Row>
      </FilterMenu>

      {managers.length > 0 && (
        <FilterMenu
          label="Manager"
          icon={Search}
          count={filters.managers.length}
          summary={summarise(filters.managers, (name) => name)}
        >
          <SearchBox
            value={managerQuery}
            onChange={setManagerQuery}
            placeholder="Find a manager…"
          />
          <div className="max-h-64 space-y-0.5 overflow-y-auto [scrollbar-width:thin]">
            {visibleManagers.map(({ manager, count }) => (
              <Row
                key={manager}
                active={filters.managers.includes(manager)}
                onClick={() => onToggleManager(manager)}
                count={count}
              >
                {manager}
              </Row>
            ))}
            {visibleManagers.length === 0 && <Empty>No manager by that name.</Empty>}
          </div>
        </FilterMenu>
      )}

      {/* Favourites is binary, so it is a toggle rather than a dropdown holding
          one row. A menu you open to press the only thing in it is a menu that
          should have been a button. */}
      {favouriteCount > 0 && (
        <button
          type="button"
          onClick={onToggleFavourites}
          aria-pressed={filters.favouritesOnly}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium",
            "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            filters.favouritesOnly
              ? "border-[var(--attention)]/40 bg-[var(--attention)]/10 text-foreground"
              : "border-border/70 bg-card text-muted-foreground hover:border-border hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <Star
            className={cn(
              "h-3.5 w-3.5",
              filters.favouritesOnly && "fill-[var(--attention)] text-[var(--attention)]",
            )}
            aria-hidden
          />
          Starred
          <span className="tabular-nums opacity-70">{favouriteCount}</span>
        </button>
      )}

      {total > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearFilters}
          className="h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </Button>
      )}
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative mb-1">
      <Search
        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-full rounded-md border border-border/70 bg-background pl-7 pr-2 text-xs focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1.5 text-xs text-muted-foreground">{children}</p>;
}
