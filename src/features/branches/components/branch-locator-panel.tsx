import { useEffect, useRef, useState } from "react";
import {
  Building2,
  Crosshair,
  Info,
  Loader2,
  MapPin,
  Navigation,
  Search,
  Signpost,
  Store,
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
  branch: Store,
};

const KIND_LABEL: Record<LocationKind, string> = {
  city: "City",
  district: "District",
  area: "Area",
  branch: "Branch",
};

/**
 * Height of the results list, in pixels.
 *
 * Fixed rather than grown-into, so that finding ten branches does not push the
 * directory below it off the screen — the card an agent is about to be scrolled
 * to has to still be visible when they click. One row is four lines of text plus
 * its padding, ~76px; five of those is the list an agent can take in without
 * scrolling, and everything past the fifth is one flick away.
 *
 * A max-height rather than a height: three results should occupy the room three
 * results need, not leave two rows of empty box under them.
 */
const RESULTS_MAX_HEIGHT = 5 * 76;

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

      {results.length > 0 && (
        <>
          <div className="mt-2 flex items-center gap-1.5 px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Info className="h-3 w-3 shrink-0" aria-hidden />
            {/* Stated once, above the list, rather than repeated on every row.
                The "≈" on each estimate carries it after the first read. */}
            Nearest {results.length} · soonest first · estimated under normal conditions, never
            exact
          </div>

          {/* Fixed height with its own scrollbar. The list is a finder, and a
              finder that grows until it pushes the branch cards off the screen
              defeats the click it exists to invite. */}
          <ol
            className="divide-y divide-border/40 overflow-y-auto overscroll-contain rounded-lg border border-border/50 bg-card [scrollbar-width:thin]"
            style={{ maxHeight: RESULTS_MAX_HEIGHT }}
          >
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
 * Six things and no more: the code, the city, the neighbourhood, the street, how
 * far, and when it would arrive. The phone number and the scooter badge that used
 * to sit here are on the card this row scrolls to, and both were answering a
 * question the agent has not asked yet — *which* branch comes first, and this row
 * has to answer that in one glance.
 *
 * Laid out the way a maps result is: the identifier small above, the place name
 * large, the address narrowing beneath it, and the arrival time in its own column
 * on the right. The city is the prominent line because it is the thing that
 * disqualifies a result fastest — a Riyadh branch in a list for a Jeddah customer
 * is wrong no matter how near it claims to be.
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
            "Show this branch below.",
          ]
            .filter(Boolean)
            .join(". ")}
          className={cn(
            "group flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2 text-left",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
            !active && "hover:bg-accent/40",
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
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {branch.branch_no}
              </span>
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

            {branch.district && (
              <span className="mt-px flex min-w-0 items-center gap-1 text-[11.5px] leading-4 text-foreground/75">
                <MapPin className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
                <span className="truncate" dir="auto" title={branch.district}>
                  {branch.district}
                </span>
              </span>
            )}

            {branch.street && (
              <span className="flex min-w-0 items-center gap-1 text-[11.5px] leading-4 text-muted-foreground">
                <Signpost className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
                <span className="truncate" dir="auto" title={branch.street}>
                  {branch.street}
                </span>
              </span>
            )}

            {fallbackAddress && (
              <span className="flex min-w-0 items-center gap-1 text-[11.5px] leading-4 text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
                <span className="truncate" dir="auto" title={fallbackAddress}>
                  {fallbackAddress}
                </span>
              </span>
            )}
          </span>

          {/* Arrival, then distance. In that order and at those sizes because the
              question is "how soon", and the kilometres are the working rather
              than the answer. */}
          <span className="shrink-0 pl-1 text-right" title={result.eta.detail}>
            <span className="block text-[9px] font-medium uppercase tracking-wide text-muted-foreground/80">
              Est. delivery
            </span>
            <span
              className={cn(
                "block whitespace-nowrap text-[13px] font-semibold leading-4 tabular-nums transition-colors duration-150",
                active ? "text-primary" : "text-foreground",
              )}
            >
              {result.eta.label}
            </span>
            <span className="mt-px block whitespace-nowrap text-[10px] leading-4 tabular-nums text-muted-foreground">
              {formatDistance(result.distance.metres)} away
            </span>
          </span>
        </button>

        <span className="flex shrink-0 items-center pr-1.5">
          {branch.navLink ? (
            <a
              href={branch.navLink}
              target="_blank"
              rel="noopener noreferrer"
              title="Open directions in Google Maps"
              aria-label={`Directions to ${branch.branch_no} in Google Maps`}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Navigation className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : (
            <span
              aria-hidden
              title="No coordinates on file"
              className="grid h-7 w-7 place-items-center text-muted-foreground/25"
            >
              <Navigation className="h-3.5 w-3.5" />
            </span>
          )}
        </span>
      </div>
    </li>
  );
}
