import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Crosshair,
  Info,
  Landmark,
  Loader2,
  MapPin,
  Navigation,
  Search,
  Signpost,
  Star,
  Store,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeDistance, formatDistance } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { COVERAGE_RADIUS_METRES, coverageTier, type CoverageTier } from "../delivery-eta";
import { REFERENCE_LABEL } from "../normalize";
import type { LocationEntry, LocationKind } from "../location-index";
import { branchDirectionsUrl, type LocatorResult, type ResolvedOrigin } from "../locator";

/**
 * Locator mode, in the space the search bar occupies.
 *
 * Not a modal, not a drawer, not a page: it takes over the strip above the cards
 * and leaves them exactly where they were. That is the whole design constraint.
 * An agent enters locator mode mid-call and the branch they were already looking
 * at does not move.
 *
 * Every size in here is deliberately tight. The panel sits above the content an
 * agent is trying to read, so each row of chrome it spends is a row of branch card
 * they do not see — which is why the heading is a 10px label rather than a
 * heading block, the controls are 36px rather than 44px, and the district and
 * street share one line. The floor is readability, not density for its own sake:
 * the two things the eye needs to land on, the city and the distance, kept their
 * size while everything around them gave some back.
 */

/** One icon per gazetteer kind, so the list is scannable without reading it. */
const KIND_ICON: Record<LocationKind, typeof MapPin> = {
  city: Building2,
  district: MapPin,
  street: Signpost,
  landmark: Landmark,
  branch: Store,
};

const KIND_LABEL: Record<LocationKind, string> = {
  city: "City",
  district: "District",
  street: "Street",
  landmark: "Landmark",
  branch: "Branch",
};

/**
 * Approximate height of one result row, in pixels.
 *
 * Three lines in the left column — code, city, then district and street sharing a
 * line — against three stacked metrics on the right, plus 1.5 units of vertical
 * padding. Named so the "about five rows" intent below survives the next spacing
 * change instead of quietly drifting to four and a half.
 */
const RESULT_ROW_HEIGHT = 74;

/** Visible rows before the list starts scrolling internally. */
const VISIBLE_RESULTS = 5;

/**
 * Height of the results list, in pixels.
 *
 * Capped rather than grown-into, so that finding ten branches does not push the
 * directory below it off the screen — the card an agent is about to be scrolled
 * to has to still be visible when they click. Five rows is the list an agent can
 * take in without scrolling, and everything past the fifth is one flick away.
 *
 * A max-height rather than a height: three results should occupy the room three
 * results need, not leave two rows of empty box under them.
 */
const RESULTS_MAX_HEIGHT = VISIBLE_RESULTS * RESULT_ROW_HEIGHT;

/** Sentinel for "no city scope", because a Radix Select item cannot hold "". */
const ANY_CITY = "__any__";

interface Props {
  query: string;
  /** The city scope, as written in the directory. Empty means anywhere. */
  city: string;
  /** Cities that have at least one branch, for the dropdown. */
  cities: LocationEntry[];
  origin: ResolvedOrigin | null;
  results: LocatorResult[];
  /** Places sharing the typed name across several cities. */
  choices: LocationEntry[];
  /** Live autocomplete for what is currently typed. */
  suggestions: LocationEntry[];
  error: string | null;
  searching: boolean;
  /** The branch currently highlighted in the directory, if it is one of ours. */
  selected: string | null;
  /** Minimised to the summary bar after a selection. */
  collapsed: boolean;
  onQueryChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onSearch: (value: string) => void;
  onChooseLocation: (entry: LocationEntry) => void;
  onSelect: (branchNo: string) => void;
  onExpand: () => void;
  onClose: () => void;
}

export function BranchLocatorPanel({
  query,
  city,
  cities,
  origin,
  results,
  choices,
  suggestions,
  error,
  searching,
  selected,
  collapsed,
  onQueryChange,
  onCityChange,
  onSearch,
  onChooseLocation,
  onSelect,
  onExpand,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);

  // Locator mode is entered to type a location, so the caret starts there.
  // Skipped while collapsed: there is no input to focus, and stealing focus on
  // the frame the panel minimises would scroll the page back up.
  useEffect(() => {
    if (!collapsed) inputRef.current?.focus();
  }, [collapsed]);

  const chosen = selected ? results.find((entry) => entry.item.branch_no === selected) : undefined;

  if (collapsed) {
    return (
      <SelectedSummary result={chosen} selected={selected} onExpand={onExpand} onClose={onClose} />
    );
  }

  // Only while the box has focus AND there is something to offer. An
  // autocomplete that stays open after a submit covers the results it produced.
  const showSuggestions = suggestOpen && suggestions.length > 0;

  const pickSuggestion = (entry: LocationEntry) => {
    setSuggestOpen(false);
    onChooseLocation(entry);
    inputRef.current?.blur();
  };

  return (
    <section
      aria-label="Branch Locator"
      className="rounded-lg border border-primary/30 bg-primary/[0.03] p-2 dark:bg-primary/[0.06]"
    >
      {/* The title sits on the same line as the close control and is a label
          rather than a heading block. It used to own a 32px strip of its own. */}
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <h2 className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          <Crosshair className="h-3 w-3" aria-hidden />
          Branch Locator
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
          Close
        </Button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSuggestOpen(false);
          onSearch(query);
        }}
        // Wraps on a phone so the city select and the submit button each get a
        // usable width instead of three controls squeezed onto one 360px line.
        className="flex flex-wrap items-center gap-2"
      >
        {/* The suggestion list is a sibling of the input inside this wrapper, so
            focus moving from the box into a suggestion never leaves the wrapper
            — which is how the list survives a Tab and still closes the moment
            focus goes anywhere else. Same device as the directory search. */}
        <div
          className="relative min-w-0 flex-1"
          onFocus={() => setSuggestOpen(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setSuggestOpen(false);
            }
          }}
        >
          <MapPin
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
              setSuggestOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && showSuggestions) {
                event.stopPropagation();
                setSuggestOpen(false);
              }
            }}
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Customer location — a city, district, coordinates or a Maps link…"
            aria-label="Customer location"
            aria-describedby="locator-origin"
            aria-expanded={showSuggestions}
            aria-controls="locator-suggestions"
            role="combobox"
            className={cn(
              "h-9 w-full rounded-md border bg-card pl-9 pr-2.5 text-[13px] font-medium shadow-sm",
              "placeholder:font-normal placeholder:text-muted-foreground/70",
              "border-border/70 transition-[border-color,box-shadow] duration-150 hover:border-border",
              "focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15",
              "[&::-webkit-search-cancel-button]:appearance-none",
            )}
          />

          {showSuggestions && (
            <ul
              id="locator-suggestions"
              role="listbox"
              aria-label="Matching places"
              className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-lg border border-border/70 bg-popover shadow-xl duration-150 animate-in fade-in slide-in-from-top-1"
            >
              {suggestions.map((entry) => (
                <li key={entry.id} role="option" aria-selected={false}>
                  <SuggestionRow entry={entry} onPick={() => pickSuggestion(entry)} />
                </li>
              ))}
            </ul>
          )}
        </div>
        {/*
          The optional city scope.

          Optional in the strong sense: "Any city" is the default and every
          feature works without touching it. It exists for one specific failure —
          "الروضة" is a district in Riyadh, Jeddah and Dammam, and "اليرموك" in
          Riyadh, Tabuk and Hail — where the panel would otherwise have to stop
          and ask. Setting it re-runs the search immediately rather than waiting
          for another press of Find, because an agent reaches for it *because* the
          answer on screen is for the wrong city.
        */}
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
          <Select
            value={city || ANY_CITY}
            onValueChange={(value) => onCityChange(value === ANY_CITY ? "" : value)}
          >
            <SelectTrigger
              aria-label="Limit the search to one city"
              className={cn(
                "h-9 min-w-0 flex-1 gap-1.5 border-border/70 bg-card text-[13px] shadow-sm sm:w-36 sm:flex-none",
                city && "border-primary/50 font-medium text-foreground",
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
                  {entry.english && entry.english !== entry.name && (
                    <span className="ml-1.5 text-xs text-muted-foreground" dir="auto">
                      {entry.name}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            type="submit"
            className="h-9 shrink-0 gap-1.5 px-3 text-[13px]"
            disabled={searching}
          >
            {searching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Find nearest</span>
          </Button>
        </div>
      </form>

      {/* What the distances were measured from. An agent quoting a number to a
          customer needs to know whether it came from their pin or from the
          middle of a city. */}
      <p id="locator-origin" className="mt-1 min-h-4 px-0.5 text-[10.5px] leading-4">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : origin ? (
          <span className="text-muted-foreground">
            <span
              className={cn(
                "text-foreground/80",
                origin.kind === "place" ? "font-medium" : "font-mono",
              )}
              dir={origin.kind === "place" ? "auto" : "ltr"}
            >
              {origin.label}
            </span>
            {" · "}
            {origin.detail}
          </span>
        ) : (
          <span className="text-muted-foreground/70">
            Type a city or district, or paste a location pin.
          </span>
        )}
      </p>

      {/* Ambiguity is a question, not a guess. "الروضة" is a district in
          Riyadh, in Jeddah and in Dammam, and quietly taking the one with the
          most branches would send a customer to the wrong city. */}
      {choices.length > 0 && (
        <div className="mt-2 rounded-lg border border-[var(--attention)]/40 bg-[var(--attention)]/10 p-2">
          <p className="flex items-center gap-1.5 px-0.5 pb-1.5 text-[11px] font-medium text-[var(--attention)]">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            That name exists in more than one city. Which one?
          </p>
          <ul className="overflow-hidden rounded-md border border-border/50 bg-card">
            {choices.map((entry) => (
              <li key={entry.id} className="border-b border-border/40 last:border-b-0">
                <SuggestionRow entry={entry} onPick={() => onChooseLocation(entry)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {origin && results.length === 0 && !searching && (
        <p className="mt-2 rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
          No branch in the directory has coordinates near that location.
        </p>
      )}

      {results.length > 0 && origin && (
        <>
          {/* The recommendation. Same ranking as the list — it *is* the list's
              first row — surfaced separately because an agent mid-call wants one
              answer, and scanning ten rows to work out that the top one already
              was the answer is the work this saves. */}
          <RecommendedBranch
            result={results[0]}
            origin={origin}
            active={selected === results[0].item.branch_no}
            onSelect={onSelect}
          />

          {results.length > 1 && (
            <>
              <div className="mt-2 flex items-center gap-1.5 px-0.5 pb-1 text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">
                <Info className="h-3 w-3 shrink-0" aria-hidden />
                {/* Stated once, above the list, rather than repeated on every
                    row. The "≈" on each estimate carries it after the first
                    read. */}
                {results.length - 1} more nearby · in-coverage first, then nearest · estimates are
                approximate
              </div>

              {/* Fixed height with its own scrollbar. The list is a finder, and a
                  finder that grows until it pushes the branch cards off the
                  screen defeats the click it exists to invite.

                  No `overscroll-contain`: it stopped a wheel that reached the end
                  of this list from continuing to the directory beneath, which is
                  the "page scrolling feels blocked" complaint. Chaining is the
                  natural behaviour and the default. */}
              <ol
                className="divide-y divide-border/40 overflow-y-auto rounded-lg border border-border/50 bg-card [scrollbar-width:thin]"
                style={{ maxHeight: RESULTS_MAX_HEIGHT }}
              >
                {results.slice(1).map((result, index) => (
                  <LocatorRow
                    key={result.item.branch_no}
                    result={result}
                    origin={origin}
                    rank={index + 2}
                    active={selected === result.item.branch_no}
                    onSelect={onSelect}
                  />
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The locator, minimised to one line after a branch has been chosen.
 *
 * Collapsed rather than closed, and that distinction is the whole feature: the
 * search text, the city scope and the ranked results are all still in memory, so
 * "Change search" reopens exactly what was there instead of making an agent
 * retype a location mid-call. What it buys is vertical space — the panel at full
 * height is most of a laptop screen, and once a branch is picked the thing worth
 * looking at is the card below it.
 *
 * `result` can be missing even with a branch selected: the agent may have picked
 * a card directly, or re-filtered the directory so the chosen branch is no longer
 * among the locator's results. The code alone is still worth stating in that case,
 * so the bar degrades to it rather than disappearing.
 */
function SelectedSummary({
  result,
  selected,
  onExpand,
  onClose,
}: {
  result: LocatorResult | undefined;
  selected: string | null;
  onExpand: () => void;
  onClose: () => void;
}) {
  const branch = result?.item;
  const city = branch ? (branch.cityEnglish ?? branch.city) : null;

  return (
    <section
      aria-label="Branch Locator — selected branch"
      className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/[0.03] px-2.5 py-2 dark:bg-primary/[0.06]"
    >
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
      >
        <Crosshair className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[9.5px] font-semibold uppercase tracking-wide text-primary">
          Selected branch
        </p>
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-[13px] font-bold text-foreground">{selected ?? "—"}</span>
          {city && (
            <span className="truncate text-[12px] font-medium text-foreground/80" dir="auto">
              {city}
            </span>
          )}
          {branch?.district && (
            <span className="truncate text-[11px] text-muted-foreground" dir="auto">
              {branch.district}
            </span>
          )}
          {result && (
            <span className="text-[11px] font-semibold tabular-nums text-foreground/70">
              {formatDistance(result.distance.metres)}
            </span>
          )}
          {result && <CoverageBadge tier={coverageTier(result.distance.metres)} compact />}
        </p>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={onExpand}
        className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Change search</span>
        <span className="sm:hidden">Search</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        aria-label="Close locator"
        title="Close locator"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </Button>
    </section>
  );
}

/**
 * The delivery-coverage verdict, as a badge.
 *
 * Three tiers now, one shape. Green is reassurance, amber says "available, but
 * near the edge — mention it", red is an operational problem the agent has to act
 * on: the order needs an exception, a different branch, or a conversation with the
 * customer. The escalation is carried by colour *and* by icon, because a badge
 * that only differs by hue is a badge a colour-blind agent cannot triage.
 *
 * One component and one set of paddings for all three, so the row's vertical
 * rhythm does not shift when a branch happens to be far away. `compact` shortens
 * the wording for a result row, where the column is narrow — the colour, the
 * icon, the shape and the spacing are identical, and the full sentence stays
 * available on the tooltip and to a screen reader.
 */
const COVERAGE_BADGE: Record<
  CoverageTier,
  { label: string; short: string; icon: typeof CheckCircle2; classes: string; title: string }
> = {
  available: {
    label: "Delivery available",
    short: "Available",
    icon: CheckCircle2,
    classes: "bg-[var(--positive)]/12 text-[var(--positive)] ring-[var(--positive)]/25",
    title: "Inside normal delivery coverage",
  },
  "near-limit": {
    label: "Near coverage limit",
    short: "Near limit",
    icon: AlertTriangle,
    classes: "bg-[var(--attention)]/15 text-[var(--attention)] ring-[var(--attention)]/30",
    title: "Inside coverage but close to the edge — worth mentioning on the call",
  },
  outside: {
    label: "Outside delivery coverage",
    short: "Outside",
    icon: AlertTriangle,
    classes: "bg-[var(--negative)]/15 text-[var(--negative)] ring-[var(--negative)]/35",
    title: "Beyond normal delivery coverage — this order needs an exception",
  },
};

function CoverageBadge({
  tier,
  compact,
  className,
}: {
  tier: CoverageTier;
  compact?: boolean;
  className?: string;
}) {
  const km = Math.round(COVERAGE_RADIUS_METRES / 1000);
  const spec = COVERAGE_BADGE[tier];
  const Icon = spec.icon;

  return (
    <span
      title={`${spec.title} (${km} km)`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold ring-1 ring-inset",
        spec.classes,
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
      {/* The visible text may be abbreviated, so it is hidden from assistive tech
          and the full wording supplied once alongside it — never both, which is
          how a badge ends up read out twice. */}
      <span aria-hidden>{compact ? spec.short : spec.label}</span>
      <span className="sr-only">{spec.label}</span>
    </span>
  );
}

/** The Directions control, shared by the recommendation card and the rows. */
function DirectionsButton({
  result,
  origin,
  compact,
}: {
  result: LocatorResult;
  origin: ResolvedOrigin;
  compact?: boolean;
}) {
  const href = branchDirectionsUrl(origin.point, result.item);
  const label = `Directions from ${origin.label} to ${result.item.branch_no}`;

  if (!href) {
    return (
      <span
        aria-hidden
        title="No coordinates on file for this branch"
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-muted-foreground/25",
          compact ? "h-9 w-9" : "h-8 px-2",
        )}
      >
        <Navigation className="h-3.5 w-3.5" />
        {!compact && <span className="text-xs">Directions</span>}
      </span>
    );
  }

  return (
    <Button
      asChild
      size="sm"
      variant={compact ? "ghost" : "outline"}
      // 36px square when compact — the smallest comfortable touch target, and the
      // old 28px one was under every guideline for a control an agent taps on a
      // tablet on the call floor.
      className={cn("shrink-0 gap-1 px-2 text-xs", compact ? "h-9 w-9 px-0" : "h-8")}
      // The row underneath is a button too; without this, asking for directions
      // would also select the branch and scroll the page away.
      onClick={(event) => event.stopPropagation()}
    >
      <a href={href} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}>
        <Navigation className="h-3.5 w-3.5" aria-hidden />
        {compact ? <span className="sr-only">Directions</span> : "Directions"}
      </a>
    </Button>
  );
}

/**
 * Distance, then the estimate under it.
 *
 * The size relationship is the point: distance is the number an agent quotes,
 * checks against coverage and compares between branches, so it is the largest
 * thing in the block and the estimate is explicitly subordinate to it. When the
 * branch is outside coverage the estimate is demoted further still — a delivery
 * that needs an exception has no meaningful ETA yet, and printing one at full
 * strength beside a warning invites reading past the warning.
 */
function DistanceBlock({ result, size }: { result: LocatorResult; size: "row" | "hero" }) {
  const tier = coverageTier(result.distance.metres);
  const hero = size === "hero";

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          "whitespace-nowrap font-bold leading-none tabular-nums text-foreground",
          hero ? "text-[26px]" : "text-lg",
        )}
      >
        {formatDistance(result.distance.metres)}
      </div>

      {/* Directly under the distance, because the two are read as one statement:
          how far, and whether that distance can actually be served. */}
      <CoverageBadge tier={tier} compact={!hero} />

      <div className="text-right">
        <div
          className={cn(
            "whitespace-nowrap text-[9px] font-medium uppercase tracking-wide",
            tier === "outside" ? "text-muted-foreground/50" : "text-muted-foreground/80",
          )}
        >
          Estimated delivery
        </div>
        <div
          title={result.eta.detail}
          className={cn(
            "whitespace-nowrap font-semibold leading-4 tabular-nums",
            hero ? "text-[13px]" : "text-[11.5px]",
            // Demoted when the branch cannot deliver normally: an ETA for a
            // trip that needs an exception is not yet a real promise, and giving
            // it full weight beside a red badge invites reading past the badge.
            tier === "outside" ? "text-muted-foreground/60" : "text-foreground/80",
          )}
        >
          {result.eta.label}
        </div>
      </div>
    </div>
  );
}

/**
 * The recommended branch.
 *
 * Not a second ranking — deriving a "best" branch by different rules from the
 * ones that ordered the list is how a panel ends up recommending its own third
 * row. This is `results[0]`, presented with more weight.
 *
 * One click, not two. The card *is* the button: a separate "Select branch" action
 * underneath it was a second control for the thing the whole card already
 * invites, and on a panel whose job is to shed height it cost a full row to say
 * nothing new. Directions stays a sibling of that button rather than a child,
 * because a link inside a button is one control to a mouse and two to a keyboard.
 */
function RecommendedBranch({
  result,
  origin,
  active,
  onSelect,
}: {
  result: LocatorResult;
  origin: ResolvedOrigin;
  active: boolean;
  onSelect: (branchNo: string) => void;
}) {
  const branch = result.item;
  const cityPrimary = branch.cityEnglish ?? branch.city;
  const citySecondary = branch.cityEnglish ? branch.city : null;
  const referenceLabel = branch.reference ? REFERENCE_LABEL[branch.reference] : null;

  return (
    <div
      className={cn(
        "relative mt-1.5 flex items-stretch overflow-hidden rounded-lg border bg-card",
        "transition-[border-color,box-shadow] duration-200",
        active
          ? "border-primary ring-1 ring-primary/25"
          : "border-primary/30 hover:border-primary/60 hover:shadow-sm",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(branch.branch_no)}
        aria-current={active ? "true" : undefined}
        aria-label={[
          `Recommended: ${branch.branch_no} in ${cityPrimary}`,
          branch.district,
          branch.street,
          describeDistance(result.distance),
          `estimated delivery ${spokenDelivery(result)}`,
          COVERAGE_BADGE[coverageTier(result.distance.metres)].label,
          "Show this branch below.",
        ]
          .filter(Boolean)
          .join(". ")}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-start gap-3 px-2.5 py-2 text-left",
          "transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
          !active && "hover:bg-accent/30",
        )}
      >
        <span className="min-w-0 flex-1">
          {/* The star and the code share the top line rather than the star owning
              a banner of its own. The banner was 22px of chrome to say one word. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-primary">
              <Star className="h-2.5 w-2.5 fill-current" aria-hidden />
              Recommended
            </span>
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {branch.branch_no}
            </span>
            {referenceLabel && (
              <span className="rounded-full bg-[var(--attention)]/12 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--attention)]">
                {referenceLabel}
              </span>
            )}
          </span>

          <span
            className="mt-0.5 block truncate text-[15px] font-semibold leading-5 tracking-tight text-foreground"
            dir="auto"
          >
            {cityPrimary}
            {citySecondary && (
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                {citySecondary}
              </span>
            )}
          </span>

          {/* District and street on one line, separated by a dot. Two icon rows
              cost two lines to carry a single address. */}
          {(branch.district || branch.street) && (
            <span className="mt-px flex min-w-0 items-center gap-1 text-[11.5px] leading-4 text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
              <span className="truncate" dir="auto">
                {[branch.district, branch.street].filter(Boolean).join(" · ")}
              </span>
            </span>
          )}
        </span>

        <DistanceBlock result={result} size="hero" />
      </button>

      {/* A sibling of the button, never nested inside it. */}
      <span className="flex shrink-0 items-center border-l border-border/40 px-1">
        <DirectionsButton result={result} origin={origin} compact />
      </span>
    </div>
  );
}

/**
 * One place, in the autocomplete list or the city chooser.
 *
 * Shared by both on purpose: they are the same question ("which place did you
 * mean") asked at two moments, and two components would drift on the day the
 * kind badge or the branch count changes.
 */
function SuggestionRow({ entry, onPick }: { entry: LocationEntry; onPick: () => void }) {
  const Icon = KIND_ICON[entry.kind];
  const context = entry.kind === "city" ? entry.english : (entry.cityEnglish ?? entry.city);

  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`${entry.name}${context ? `, ${context}` : ""}, ${KIND_LABEL[entry.kind]}, ${
        entry.branchCount === 1 ? "1 branch" : `${entry.branchCount} branches`
      }`}
      className={cn(
        "flex w-full items-center gap-2.5 px-2.5 py-2 text-left",
        "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground" dir="auto">
          {entry.name}
        </span>
        {context && (
          <span className="block truncate text-[11px] text-muted-foreground" dir="auto">
            {context}
          </span>
        )}
      </span>
      <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {KIND_LABEL[entry.kind]}
      </span>
      <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {entry.branchCount} {entry.branchCount === 1 ? "br" : "brs"}
      </span>
    </button>
  );
}

/** "about 25 to 30 minutes" — the estimate as a screen reader should say it. */
function spokenDelivery(result: LocatorResult): string {
  const { minMinutes, maxMinutes } = result.eta;
  return maxMinutes == null
    ? `about ${minMinutes} minutes or more`
    : `about ${minMinutes} to ${maxMinutes} minutes`;
}

/**
 * One result.
 *
 * Eight things and no more: the code, the city, the neighbourhood, the street, how
 * far, when it would arrive, whether it can deliver at all, and a way to hand the
 * route to a driver. The phone number and the scooter badge that used to sit here
 * are on the card this row scrolls to, and both were answering a question the
 * agent has not asked yet — *which* branch comes first, and this row has to
 * answer that in one glance. (The scooter is not gone, it moved: it breaks ties in
 * the ranking, so it decides the order rather than competing for the eye.)
 *
 * Laid out the way a maps result is: the identifier small above, the place name
 * large, the address narrowing beneath it, and the metrics in their own column on
 * the right. Distance is the biggest thing in the row because it is the number an
 * agent quotes and the one the coverage rule is about; the city is the prominent
 * *line* because it is what disqualifies a result fastest — a Riyadh branch in a
 * list for a Jeddah customer is wrong no matter how near it claims to be.
 *
 * The row is a button and Directions is a sibling link, never a link nested inside
 * the button — nesting them produces a control that is one thing to a mouse and
 * two to a keyboard, and screen readers disagree about which wins.
 */
function LocatorRow({
  result,
  origin,
  rank,
  active,
  onSelect,
}: {
  result: LocatorResult;
  origin: ResolvedOrigin;
  rank: number;
  active: boolean;
  onSelect: (branchNo: string) => void;
}) {
  const branch = result.item;
  const referenceLabel = branch.reference ? REFERENCE_LABEL[branch.reference] : null;

  // English leads when there is one, because that is the form an agent reads out
  // in a mixed-language call; the sheet's own spelling follows it rather than
  // being replaced by it.
  const cityPrimary = branch.cityEnglish ?? branch.city;
  const citySecondary = branch.cityEnglish ? branch.city : null;

  // The district and the street when the address parsed into them, and the
  // address line itself when it did not — an unparsed address is still the only
  // thing that distinguishes two branches in the same city.
  const parsedAddress = Boolean(branch.district || branch.street);
  const fallbackAddress = parsedAddress ? null : branch.addressLine;
  /** The whole address as one string, for the `title` and the empty check. */
  const addressLine = parsedAddress
    ? [branch.district, branch.street].filter(Boolean).join(" · ")
    : fallbackAddress;

  return (
    <li className="relative">
      {/* Selected-row rail. The same device the branch card uses for the same
          state, so the two highlights read as one selection rather than two. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 z-10 w-[3px] bg-primary transition-opacity duration-200",
          active ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        className={cn(
          "flex items-stretch transition-colors duration-150",
          active && "bg-primary/[0.07] dark:bg-primary/[0.12]",
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(branch.branch_no)}
          aria-current={active ? "true" : undefined}
          // Spelled out because the row's own text reads as a run of fragments;
          // this is the sentence somebody listening actually needs.
          aria-label={[
            `${branch.branch_no} in ${cityPrimary}`,
            branch.district,
            branch.street,
            describeDistance(result.distance),
            `estimated delivery ${spokenDelivery(result)}`,
            COVERAGE_BADGE[coverageTier(result.distance.metres)].label,
            "Show this branch below.",
          ]
            .filter(Boolean)
            .join(". ")}
          className={cn(
            "group flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 px-2.5 py-1.5 text-left",
            // 200ms and on both colour and shadow: a row is a click target, and a
            // target that lifts very slightly under the pointer reads as pressable
            // in a way a background tint alone does not.
            "transition-[background-color,box-shadow] duration-200 ease-out",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
            !active && "hover:bg-accent/40 hover:shadow-[inset_0_0_0_1px_var(--color-border)]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold tabular-nums transition-colors duration-150",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground group-hover:bg-primary/15 group-hover:text-primary",
            )}
          >
            {rank}
          </span>

          <span className="min-w-0 flex-1">
            {/* The code, as a maps result labels its category: present, findable,
                and not competing with the place name underneath it. */}
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {branch.branch_no}
              </span>
              {/* The coverage badge lives under the distance, not here: it is a
                  statement about the distance and stating it twice in one row was
                  the duplication the layout review turned up. */}
              {referenceLabel && (
                // Kept where the phone and the scooter badge were dropped: this
                // is not branch detail, it is a warning that the row is not a
                // pharmacy and no customer should be sent to it.
                <span className="shrink-0 rounded-full bg-[var(--attention)]/12 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--attention)]">
                  {referenceLabel}
                </span>
              )}
            </span>

            <span
              className="block truncate text-[14px] font-semibold leading-5 tracking-tight text-foreground"
              dir="auto"
            >
              {cityPrimary}
              {citySecondary && (
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  {citySecondary}
                </span>
              )}
            </span>

            {/* District and street on one line rather than two.
                Both are still shown — that is what the row is for — but two icon
                rows spent two lines carrying one address, and across five visible
                results that was five lines of the panel's height for punctuation
                that a middle dot supplies. The street keeps its own icon inside the
                line so the two halves stay distinguishable at a glance. */}
            {addressLine && (
              <span className="mt-px flex min-w-0 items-center gap-1 text-[11.5px] leading-4 text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
                <span className="truncate" dir="auto" title={addressLine}>
                  {branch.district && <span className="text-foreground/75">{branch.district}</span>}
                  {branch.district && branch.street && " · "}
                  {branch.street}
                  {!branch.district && !branch.street && fallbackAddress}
                </span>
              </span>
            )}
          </span>

          {/* Distance first and largest, the estimate subordinate to it. */}
          <span className="shrink-0 pl-1">
            <DistanceBlock result={result} size="row" />
          </span>
        </button>

        <span className="flex shrink-0 items-center pr-1.5">
          <DirectionsButton result={result} origin={origin} compact />
        </span>
      </div>
    </li>
  );
}
