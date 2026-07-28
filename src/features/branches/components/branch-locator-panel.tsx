import { useEffect, useRef } from "react";
import {
  Ban,
  Bike,
  Crosshair,
  Info,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeDistance, formatDistance } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { REFERENCE_LABEL } from "../normalize";
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

interface Props {
  query: string;
  origin: ResolvedOrigin | null;
  results: LocatorResult[];
  error: string | null;
  searching: boolean;
  /** The branch currently highlighted in the directory, if it is one of ours. */
  selected: string | null;
  onQueryChange: (value: string) => void;
  onSearch: (value: string) => void;
  onSelect: (branchNo: string) => void;
  onClose: () => void;
}

export function BranchLocatorPanel({
  query,
  origin,
  results,
  error,
  searching,
  selected,
  onQueryChange,
  onSearch,
  onSelect,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Locator mode is entered to type a location, so the caret starts there.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
          onSearch(query);
        }}
        className="flex items-center gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <MapPin
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Customer location — coordinates, a Google Maps link, a district or a city…"
            aria-label="Customer location"
            aria-describedby="locator-origin"
            className={cn(
              "h-11 w-full rounded-lg border bg-card pl-10 pr-3 text-sm font-medium shadow-sm",
              "placeholder:font-normal placeholder:text-muted-foreground/70",
              "border-border/70 transition-[border-color,box-shadow] duration-150 hover:border-border",
              "focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15",
              "[&::-webkit-search-cancel-button]:appearance-none",
            )}
          />
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
            <span className="font-mono text-foreground/80" dir="ltr">
              {origin.label}
            </span>
            {" · "}
            {origin.detail}
          </span>
        ) : (
          <span className="text-muted-foreground/70">
            Paste a location pin, or type a city or district.
          </span>
        )}
      </p>

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
