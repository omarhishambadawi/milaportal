import { useCallback, useState, type ReactNode } from "react";
import {
  ChevronDown,
  CircleDot,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Truck,
  UserRound,
  Users2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/date-range-picker";
import { STATUSES, TEAMS } from "@/lib/branches";
import { cn } from "@/lib/utils";

import { FULFILLMENT_OPTIONS, VERIFICATION_OPTIONS } from "../constants";
import type { useOrdersListFilters } from "../hooks/use-orders-list-filters";
import { OrdersScopeTabs } from "./orders-scope-tabs";

/** Ties the narrow-width Filters button to the group it opens. */
const FILTERS_ID = "orders-filter-group";

/**
 * The Orders toolbar: scope, search, filters, date, reset.
 *
 * ## What changed and why
 *
 * The controls were split across two containers — the scope buttons and Export
 * lived in the page header, the dropdowns in a card below it — so the page asked
 * "which orders?" in two places, in two visual languages, twenty pixels apart.
 * They are one strip now. The header keeps the title and the count; everything
 * that *narrows the list* is here, on one baseline, at one height.
 *
 * Reading order left to right is the order an agent works in: the set (scope),
 * the one order they are looking for (search), then the ways of narrowing a set
 * they are browsing (the dropdowns, then the date), then the way out (reset).
 * The bar wraps rather than scrolling, and every group is `shrink-0` except the
 * search field, so what gives way under pressure is the one control that reads
 * fine at any width.
 *
 * ## Active filters are visible without being loud
 *
 * A set dropdown gets a tinted border and a filled label; an unset one is a
 * plain outline reading "All statuses". That is enough to answer "why am I
 * seeing so few rows" at a glance without a row of removable chips under the
 * bar — which would be a second, taller control saying what the first already
 * says. **Reset** appears only when there is something to reset, and carries the
 * count, so the bar has no dead affordance in its resting state.
 *
 * Everything is a controlled prop on `useOrdersListFilters`. There is no filter
 * state in this component: each control sets exactly one value through
 * `onFilterChange`, which is what keeps them independent — applying one never
 * disturbs another, and clearing one never clears the rest.
 */
export function OrdersToolbar({ f }: { f: ReturnType<typeof useOrdersListFilters> }) {
  const { onFilterChange, setMineOnly, setStarredOnly } = f;

  /**
   * Whether the dropdown group is open — **below `lg` only**.
   *
   * From `lg` the group is `contents` and always laid out, so this state simply
   * stops being consulted rather than being read at the wrong breakpoint. Closed
   * on mount: on a tablet the first thing an agent wants is the list, and the
   * count on the button says whether anything is narrowing it.
   */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const selectScope = useCallback(
    (mine: boolean) => {
      // Guarded: `onFilterChange` resets to page 1, which is right when the set
      // changes and wrong when clicking the scope you are already on.
      if (mine !== f.mineOnly) onFilterChange(() => setMineOnly(mine));
    },
    [f.mineOnly, onFilterChange, setMineOnly],
  );

  const toggleStarred = useCallback(
    () => onFilterChange(() => setStarredOnly((v) => !v)),
    [onFilterChange, setStarredOnly],
  );

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 p-2 sm:p-2.5">
        <OrdersScopeTabs
          mineOnly={f.mineOnly}
          starredOnly={f.starredOnly}
          starredCount={f.starred.size}
          canStar={f.canStar}
          onSelectScope={selectScope}
          onToggleStarred={toggleStarred}
        />

        <OrdersSearch
          value={f.q}
          onChange={(v) => {
            f.setQ(v);
            f.setPage(0);
          }}
        />

        <DateRangePicker
          range={f.range}
          onChange={(r) => {
            f.setRange(r);
            f.setPage(0);
          }}
          disabled={f.searching}
          className="h-9 w-[178px] shrink-0 text-sm"
        />

        {/* Below `lg` the five dropdowns are behind this. Five fixed-width
            controls plus the scope, the search and the date wrapped to five rows
            — 230px of filter bar above a list, measured on the 256px sidebar
            this was written against — and four of those rows were saying "all".
            The rail is 92px now, so `md` gets a row or two back; the case is
            unchanged below `sm`, where there is no rail at all and the bar has
            the width of a phone. They are one button with a count until they are
            wanted. */}
        <Button
          variant="outline"
          size="sm"
          aria-expanded={filtersOpen}
          aria-controls={FILTERS_ID}
          onClick={() => setFiltersOpen((v) => !v)}
          className={cn(
            "h-9 shrink-0 gap-1.5 px-2.5 text-xs font-medium lg:hidden",
            f.activeFilterCount > 0 && "border-primary/70 bg-primary/[0.06]",
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          Filters
          {f.activeFilterCount > 0 && (
            <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold leading-4 tabular-nums text-primary-ink">
              {f.activeFilterCount}
            </span>
          )}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-200",
              filtersOpen && "rotate-180",
            )}
            aria-hidden
          />
        </Button>

        {/* Divides "which set / which order" from "narrow it". Only where the bar
            is wide enough to be one row — on a wrapped bar it would be a rule in
            the middle of nowhere. */}
        <span className="mx-0.5 hidden h-6 w-px shrink-0 bg-border xl:block" aria-hidden />

        {/*
          The dropdowns, rendered **once**.

          `lg:contents` is what makes that possible: from `lg` the wrapper stops
          generating a box and its children lay themselves out as direct items of
          the toolbar's flex row, exactly as if it were not there. Below `lg` it
          is an ordinary full-width row that the button above shows and hides. One
          set of Radix Selects, one piece of state, two layouts.
        */}
        <div
          id={FILTERS_ID}
          className={cn(
            "w-full flex-wrap items-center gap-2 lg:contents",
            filtersOpen
              ? "flex animate-in fade-in slide-in-from-top-1 duration-200 lg:animate-none"
              : "hidden",
          )}
        >
          <FilterSelect
            icon={CircleDot}
            label="Status"
            value={f.status}
            active={f.status !== "all"}
            width="w-[140px]"
            onValueChange={(v) => onFilterChange(() => f.setStatus(v))}
          >
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </FilterSelect>

          {/* Invoice Verification — the same three states the row's first column
              paints, read through `features/orders/verification.ts` so the filter
              and the column cannot describe different sets. */}
          <FilterSelect
            icon={ShieldCheck}
            label="Verification"
            value={f.verification}
            active={f.verification !== "all"}
            width="w-[158px]"
            onValueChange={(v) => onFilterChange(() => f.setVerification(v))}
          >
            {VERIFICATION_OPTIONS.map((o) => (
              // The hint on `title` rather than a second line in the item.
              // "Non Call Centre" is the one option whose label does not explain
              // itself, and a subtitle on all five to caption one of them would
              // make the list twice as tall as every other dropdown in the bar.
              <SelectItem key={o.value} value={o.value} title={o.hint}>
                {o.label}
              </SelectItem>
            ))}
          </FilterSelect>

          {/* Delivery & Pickup, at two resolutions in one control: the grouped
              question at the top, the individual methods under it, so picking
              "Azman" never means leaving the grouped view first. */}
          <FilterSelect
            icon={Truck}
            label="Fulfillment"
            value={f.fulfillment}
            active={f.fulfillment !== "all"}
            width="w-[182px]"
            onValueChange={(v) => onFilterChange(() => f.setFulfillment(v))}
          >
            <SelectItem value="all">Delivery &amp; Pickup</SelectItem>
            {FULFILLMENT_OPTIONS.filter((o) => o.group === "fulfillment").map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
            <SelectSeparator />
            {/* SelectLabel reads its group from context, so it must sit inside a
                SelectGroup — as a direct child of SelectContent it throws and takes
                the whole page down. */}
            <SelectGroup>
              <SelectLabel>Method</SelectLabel>
              {FULFILLMENT_OPTIONS.filter((o) => o.group === "method").map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </FilterSelect>

          <FilterSelect
            icon={Users2}
            label="Team"
            value={f.team}
            active={f.team !== "all"}
            width="w-[144px]"
            onValueChange={(v) =>
              onFilterChange(() => {
                f.setTeam(v);
                // The agent list is scoped to the team, so a selection that is no
                // longer offered has to go with it.
                f.setAgent("all");
              })
            }
          >
            <SelectItem value="all">All teams</SelectItem>
            {TEAMS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </FilterSelect>

          {/* `view_all_agents`, not administrator — an Auditor reviews other
              people's work and holds it by default. */}
          {f.canFilterAgents && (
            <FilterSelect
              icon={UserRound}
              label="Agent"
              value={f.agent}
              active={f.agent !== "all"}
              width="w-[156px]"
              onValueChange={(v) => onFilterChange(() => f.setAgent(v))}
            >
              <SelectItem value="all">All agents</SelectItem>
              {f.filteredAgentOpts.map((a: any) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.full_name}
                  {a.agent_code ? ` (${a.agent_code})` : ""}
                </SelectItem>
              ))}
            </FilterSelect>
          )}

          {/* Only when there is something to reset. A permanently-disabled
              button in a toolbar is a control that never does anything, and the
              count makes what it will undo explicit. */}
          {f.activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={f.resetFilters}
              className="h-9 shrink-0 animate-in gap-1.5 fade-in zoom-in-95 px-2.5 text-xs font-medium text-muted-foreground duration-150 hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Reset
              <span className="rounded bg-muted px-1 text-[10px] font-semibold leading-4 tabular-nums text-foreground">
                {f.activeFilterCount}
              </span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The Orders search field.
 *
 * A search box is not a text input with a magnifier stuck to it; it is the
 * control an agent uses more than every other on this page put together, and it
 * has to look like the one place to type. So it takes the bar's leftover width,
 * carries its icon inside the padding rather than crowding the caret, and gains
 * a ring *and* a lifted shadow on focus while keeping the same radius and border
 * as the dropdowns beside it — emphasis from prominence, not from a different
 * shape.
 *
 * The × is the part that was missing. Clearing a search meant selecting the text
 * and deleting it, on the one control agents change most often; it appears only
 * when there is something to clear, and returns focus to the field so the next
 * search is a keystroke away rather than a click away.
 */
function OrdersSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative min-w-[200px] flex-1 sm:min-w-[240px] lg:max-w-sm">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80"
        aria-hidden
      />
      <Input
        type="text"
        value={value}
        maxLength={80}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears — the convention for a search field, and the reason the
          // × does not need to be reached for at all.
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
        placeholder="Search order no., customer, invoice, agent…"
        aria-label="Search orders"
        className={cn(
          "h-9 w-full rounded-md pl-9 pr-8 text-sm shadow-sm",
          "transition-[box-shadow,border-color] duration-200",
          "placeholder:text-muted-foreground/70 focus-visible:shadow-md",
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className={cn(
            "absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded",
            "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "animate-in fade-in zoom-in-95 duration-150",
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * One filter dropdown, with its set/unset treatment.
 *
 * A thin wrapper over the design system's `Select` rather than a filtering
 * control of its own: it adds a leading glyph, a fixed width so the bar's
 * columns do not jump as values change length, and the tinted border that makes
 * an applied filter visible. The value, the options and the change handler are
 * all the caller's — this holds no state and knows nothing about orders.
 */
function FilterSelect({
  icon: Icon,
  label,
  value,
  active,
  width,
  onValueChange,
  children,
}: {
  icon: typeof CircleDot;
  /** Names the control for assistive tech; the trigger shows the value. */
  label: string;
  value: string;
  active: boolean;
  width: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          "h-9 shrink-0 gap-1.5 px-2.5 text-sm",
          // The trigger is `justify-between`, which with a leading glyph added
          // would centre the value between the two. Letting the value's span
          // take the slack keeps the text left and the chevron hard right.
          "[&>span]:flex-1 [&>span]:truncate [&>span]:text-left",
          "transition-[background-color,border-color,color] duration-200",
          width,
          active
            ? "border-primary/70 bg-primary/[0.06] font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active ? "text-primary-ink" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
