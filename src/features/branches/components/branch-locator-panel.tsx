import { useEffect, useRef, useState } from "react";
import {
  Ban,
  Bike,
  Building2,
  Crosshair,
  Info,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  Search,
  Signpost,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeDistance, formatDistance } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { REFERENCE_LABEL } from "../normalize";
import type { LocationEntry, LocationKind } from "../location-index";
import type { LocatorResult, ResolvedOrigin } from "../locator";

/**
 * Locator mode, in the space the search bar occupies.
 *
 * Not a modal, not a drawer, not a page: it takes over the strip above the list
 * and leaves the directory — cards, map, resizable split — exactly where it was.
 * That is the whole design constraint. An agent enters locator mode mid-call and
 * the branch they were already looking at does not move.
 *
 * The results stay on screen after a selection, deliberately. Picking the
 * nearest branch and finding it unreachable is a normal outcome, and the second
 * choice has to be one click away rather than a re-search.
 */

/** One icon per gazetteer kind, so the list is scannable without reading it. */
const KIND_ICON: Record<LocationKind, typeof MapPin> = {
  city: Building2,
  district: MapPin,
  area: Signpost,
};

const KIND_LABEL: Record<LocationKind, string> = {
  city: "City",
  district: "District",
  area: "Area",
};

interface Props {
  query: string;
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
  onQueryChange: (value: string) => void;
  onSearch: (value: string) => void;
  onChooseLocation: (entry: LocationEntry) => void;
  onSelect: (branchNo: string) => void;
  onClose: () => void;
}

export function BranchLocatorPanel({
  query,
  origin,
  results,
  choices,
  suggestions,
  error,
  searching,
  selected,
  onQueryChange,
  onSearch,
  onChooseLocation,
  onSelect,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);

  // Locator mode is entered to type a location, so the caret starts there.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
      className="rounded-xl border border-primary/30 bg-primary/[0.03] p-2.5 dark:bg-primary/[0.06]"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
          <Crosshair className="h-3.5 w-3.5" aria-hidden />
          Branch Locator
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
          Close locator
        </Button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSuggestOpen(false);
          onSearch(query);
        }}
        className="flex items-center gap-2"
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
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
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
              "h-11 w-full rounded-lg border bg-card pl-10 pr-3 text-sm font-medium shadow-sm",
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
        <Button type="submit" className="h-11 shrink-0 gap-1.5 px-4" disabled={searching}>
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">Find nearest</span>
        </Button>
      </form>

      {/* What the distances were measured from. An agent quoting a number to a
          customer needs to know whether it came from their pin or from the
          middle of a city. */}
      <p id="locator-origin" className="mt-1.5 min-h-4 px-0.5 text-[11px] leading-4">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : origin ? (
          <span className="text-muted-foreground">
            <span
              className={cn(
                "text-foreground/80",
                origin.kind === "place" ? "font-medium" : "font-mono",
              )}
              dir="auto"
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

      {results.length > 0 && (
        <>
          <div className="mt-2 flex items-center gap-1.5 px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Info className="h-3 w-3 shrink-0" aria-hidden />
            {/* Stated once, above the list, rather than repeated on every row.
                The "≈" on each distance carries it after the first read. */}
            Nearest {results.length} · straight-line distance, approximate — the drive will be
            longer
          </div>

          <ol className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/50 bg-card">
            {results.map((result, index) => (
              <LocatorRow
                key={result.item.branch_no}
                result={result}
                rank={index + 1}
                active={selected === result.item.branch_no}
                onSelect={onSelect}
              />
            ))}
          </ol>
        </>
      )}
    </section>
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

/**
 * One result.
 *
 * The row is a button and Navigate is a sibling link, never a link nested inside
 * the button — nesting them produces a control that is one thing to a mouse and
 * two to a keyboard, and screen readers disagree about which wins.
 */
function LocatorRow({
  result,
  rank,
  active,
  onSelect,
}: {
  result: LocatorResult;
  rank: number;
  active: boolean;
  onSelect: (branchNo: string) => void;
}) {
  const branch = result.item;
  const referenceLabel = branch.reference ? REFERENCE_LABEL[branch.reference] : null;
  const phoneLink = branch.phoneE164 ? `tel:${branch.phoneE164}` : null;

  return (
    <li className={cn("flex items-stretch gap-1 transition-colors", active && "bg-primary/10")}>
      <button
        type="button"
        onClick={() => onSelect(branch.branch_no)}
        aria-current={active ? "true" : undefined}
        // Spelled out because the row's own text reads as a run of fragments;
        // this is the sentence somebody listening actually needs.
        aria-label={`${branch.branch_no} in ${branch.cityEnglish ?? branch.city}, ${describeDistance(
          result.distance,
        )}. Show on the map.`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left",
          "transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold tabular-nums",
            active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {rank}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[13px] font-bold text-foreground">
              {branch.branch_no}
            </span>
            {referenceLabel ? (
              <span className="shrink-0 rounded-full bg-[var(--attention)]/12 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--attention)]">
                {referenceLabel}
              </span>
            ) : branch.scooter ? (
              <span
                title={branch.scooter_note ?? "Scooter delivery available"}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--positive)]/12 px-1.5 py-px text-[9px] font-semibold text-[var(--positive)]"
              >
                <Bike className="h-2.5 w-2.5" aria-hidden />
                Scooter
              </span>
            ) : (
              <span
                title="No scooter delivery"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
              >
                <Ban className="h-2.5 w-2.5" aria-hidden />
                No scooter
              </span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate" dir="auto">
              {branch.city}
              {branch.cityEnglish && ` · ${branch.cityEnglish}`}
            </span>
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-[13px] font-semibold tabular-nums text-foreground">
            ≈ {formatDistance(result.distance.metres)}
          </span>
          <span className="block text-[10px] text-muted-foreground">straight line</span>
        </span>
      </button>

      <span className="flex shrink-0 items-center gap-0.5 pr-1.5">
        {phoneLink ? (
          <a
            href={phoneLink}
            title={`Call ${branch.phoneDisplay}`}
            aria-label={`Call ${branch.branch_no} on ${branch.phoneDisplay}`}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            dir="ltr"
          >
            <Phone className="h-3 w-3 shrink-0" aria-hidden />
            <span className="hidden md:inline">{branch.phoneDisplay}</span>
          </a>
        ) : (
          <span className="px-1.5 text-[11px] text-muted-foreground/50" title="No phone on file">
            —
          </span>
        )}

        {branch.navLink ? (
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]" asChild>
            <a href={branch.navLink} target="_blank" rel="noopener noreferrer">
              <Navigation className="h-3 w-3" />
              <span className="hidden sm:inline">Navigate</span>
            </a>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled
            className="h-7 gap-1 px-2 text-[11px]"
            title="No coordinates on file"
          >
            <Navigation className="h-3 w-3" />
            <span className="hidden sm:inline">Navigate</span>
          </Button>
        )}
      </span>
    </li>
  );
}
