import { useMemo, useState } from "react";
import {
  Ban,
  Bike,
  Check,
  Clock,
  MapPinned,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { dutyHoursLabel, foldText } from "../normalize";
import { activeFilterCount, type BranchFilters } from "../search";

/**
 * Every filter, behind one button.
 *
 * Replaces the chip bar that used to sit under the search box. The chips were
 * faster to *click* but they cost two lines of a viewport-height page and they
 * were on screen during the 95% of the time nobody was filtering — and the page
 * only has room for one and a half rows of cards to begin with. A drawer rather
 * than a popover because there are five groups here, two of them lists of a
 * dozen-plus entries: that is a panel, and a panel cramped into a popover is how
 * you end up scrolling a 200px box on a phone.
 *
 * The button carries a count so a narrowed list is never a mystery, and the
 * active filters stay visible as removable pills outside the drawer.
 */

/** A checkable row. Long labels truncate; the count never does. */
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
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm",
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

function Group({
  label,
  children,
  scroll,
}: {
  label: string;
  children: React.ReactNode;
  scroll?: boolean;
}) {
  return (
    <div>
      <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div
        className={cn("space-y-0.5", scroll && "max-h-52 overflow-y-auto [scrollbar-width:thin]")}
      >
        {children}
      </div>
    </div>
  );
}

interface Props {
  filters: BranchFilters;
  resultCount: number;
  cities: { city: string; english: string | null; count: number }[];
  dutyHours: { hours: number; count: number }[];
  managers: { manager: string; count: number }[];
  favouriteCount: number;
  onToggleCity: (city: string) => void;
  onToggleScooter: (value: "yes" | "no") => void;
  onToggleDutyHours: (hours: number) => void;
  onToggleManager: (manager: string) => void;
  onToggleFavourites: () => void;
  /** Clears the chips but keeps whatever is typed in the search box. */
  onClearFilters: () => void;
}

export function BranchFiltersDrawer({
  filters,
  resultCount,
  cities,
  dutyHours,
  managers,
  favouriteCount,
  onToggleCity,
  onToggleScooter,
  onToggleDutyHours,
  onToggleManager,
  onToggleFavourites,
  onClearFilters,
}: Props) {
  const [open, setOpen] = useState(false);
  const [managerQuery, setManagerQuery] = useState("");
  const count = activeFilterCount(filters);

  // Managers are people, and a list of people is one you scan by name. Filtering
  // it is what keeps the group usable as the network grows past a screenful.
  const visibleManagers = useMemo(() => {
    const needle = foldText(managerQuery);
    if (!needle) return managers;
    return managers.filter((entry) => foldText(entry.manager).includes(needle));
  }, [managers, managerQuery]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant={count > 0 ? "secondary" : "outline"}
          // The label is hidden on phones, where the icon has to carry the
          // button — so the name is spelled out here rather than left to the
          // text content, which `display:none` removes from the a11y tree.
          aria-label={
            count > 0
              ? `Advanced filters, ${count} ${count === 1 ? "filter" : "filters"} active`
              : "Advanced filters"
          }
          className={cn(
            "h-12 shrink-0 gap-2 px-3 sm:px-4",
            count > 0 && "border border-primary/40",
          )}
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span className="hidden sm:inline">Filters</span>
          {count > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold tabular-nums text-primary-foreground">
              {count}
            </span>
          )}
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="shrink-0 border-b border-border/60 px-5 py-4 text-left">
          <SheetTitle className="text-base">Advanced filters</SheetTitle>
          <SheetDescription className="text-xs">
            {count > 0
              ? `${resultCount} ${resultCount === 1 ? "branch" : "branches"} match ${count} ${
                  count === 1 ? "filter" : "filters"
                }`
              : "Narrow the directory by city, delivery, hours or area manager."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4 [scrollbar-width:thin]">
          <Group label="Delivery">
            <Row
              active={filters.scooter === "yes"}
              onClick={() => onToggleScooter("yes")}
              icon={Bike}
            >
              Scooter available
            </Row>
            <Row active={filters.scooter === "no"} onClick={() => onToggleScooter("no")} icon={Ban}>
              No scooter
            </Row>
          </Group>

          {favouriteCount > 0 && (
            <Group label="Favourites">
              <Row
                active={filters.favouritesOnly}
                onClick={onToggleFavourites}
                count={favouriteCount}
                icon={Star}
              >
                Starred branches only
              </Row>
            </Group>
          )}

          {dutyHours.length > 0 && (
            <Group label="Working hours">
              {dutyHours.map(({ hours, count: branches }) => (
                <Row
                  key={hours}
                  active={filters.dutyHours.includes(hours)}
                  onClick={() => onToggleDutyHours(hours)}
                  count={branches}
                  icon={Clock}
                >
                  {dutyHoursLabel(hours)}
                </Row>
              ))}
            </Group>
          )}

          {cities.length > 0 && (
            <Group label="City" scroll>
              {cities.map(({ city, english, count: branches }) => (
                <Row
                  key={city}
                  active={filters.cities.includes(city)}
                  onClick={() => onToggleCity(city)}
                  count={branches}
                  icon={MapPinned}
                >
                  {english ? `${english} · ${city}` : city}
                </Row>
              ))}
            </Group>
          )}

          {managers.length > 0 && (
            <Group label="Area manager">
              <div className="relative mb-1.5 px-2">
                <Search
                  className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <input
                  value={managerQuery}
                  onChange={(event) => setManagerQuery(event.target.value)}
                  placeholder="Find a manager…"
                  aria-label="Find an area manager"
                  className="h-8 w-full rounded-lg border border-border/70 bg-background pl-8 pr-2 text-xs focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <div className="max-h-52 space-y-0.5 overflow-y-auto [scrollbar-width:thin]">
                {visibleManagers.map(({ manager, count: branches }) => (
                  <Row
                    key={manager}
                    active={filters.managers.includes(manager)}
                    onClick={() => onToggleManager(manager)}
                    count={branches}
                  >
                    {manager}
                  </Row>
                ))}
                {visibleManagers.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    No manager by that name.
                  </p>
                )}
              </div>
            </Group>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearFilters}
            disabled={count === 0}
            className="text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Clear filters
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            Show {resultCount} {resultCount === 1 ? "branch" : "branches"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
