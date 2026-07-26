import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Bike,
  Check,
  Clock,
  Copy,
  MapPin,
  Navigation,
  Phone,
  Star,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { copyText } from "../clipboard";
import { Highlight } from "../highlight";
import { dutyHoursLabel, telHref } from "../normalize";
import type { BranchView } from "../types";

/**
 * Card height, in pixels.
 *
 * A single fixed number, and the virtualizer depends on it being true: every
 * row position is computed from it rather than measured. That is why the address
 * below is line-clamped and every row has a fixed height — a card that grew to
 * fit a long address would silently desynchronize the whole list's scroll
 * geometry.
 *
 * It has grown twice, from 244px, and both times for the same reason: the card
 * stopped hiding things. There is no expander now. Everything the directory
 * knows about a branch is on the face of it — the nine fields an agent reads out
 * during a call, and below a divider the four that get looked up occasionally
 * (coordinates, maps link, delivery note, last updated). Nothing about a branch
 * costs a click.
 */
export const CARD_HEIGHT = 364;

/**
 * The card's 1px border, top and bottom.
 *
 * Subtracted from the inner section's height so that CARD_HEIGHT is the card's
 * *outer* height — which is what the virtualizer positions rows by. Without
 * this the article measures 366px in a 364px slot, and every gap in the list is
 * quietly 2px short of the one the layout asks for.
 */
const CARD_BORDER = 2;

/** Height of the content area, inside the border. */
export const CARD_CONTENT_HEIGHT = CARD_HEIGHT - CARD_BORDER;

/** Minimum width one card needs before a second column is worth it. */
export const CARD_MIN_WIDTH = 340;

interface Props {
  branch: BranchView;
  selected: boolean;
  favourite: boolean;
  /** Folded query tokens, for highlighting what matched. */
  tokens: readonly string[];
  onSelect: (branchNo: string) => void;
  onToggleFavourite: (branchNo: string) => void;
}

/**
 * A copy control that confirms itself.
 *
 * The toast is still the authoritative feedback, but it appears at the edge of
 * the screen while the agent's eyes are on the card, and on a call-floor machine
 * with several toasts stacked it is genuinely ambiguous *which* copy fired. The
 * tick lands on the button that was pressed.
 */
function useCopied(): [boolean, (value: string, label: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback((value: string, label: string) => {
    // Nothing to copy is a failure `copyText` reports with an error toast; a tick
    // there would confirm something that did not happen.
    if (!value.trim()) {
      void copyText(value, label);
      return;
    }
    void copyText(value, label).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    });
  }, []);

  return [copied, copy];
}

/** Icon-only copy, for values that sit inline beside their own label. */
function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, copy] = useCopied();
  return (
    <button
      type="button"
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      title={`Copy ${label.toLowerCase()}`}
      onClick={(event) => {
        event.stopPropagation();
        copy(value, label);
      }}
      className={cn(
        "grid h-5 w-5 shrink-0 place-items-center rounded transition-colors",
        copied
          ? "text-[var(--positive)]"
          : "text-muted-foreground/60 hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3" strokeWidth={3} /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/**
 * One line of the card's operational block.
 *
 * Every row is either a fixed one line (`truncate`) or a fixed two
 * (`line-clamp-2`), never "as tall as the content" — see CARD_HEIGHT for why the
 * card's height has to be knowable without measuring it.
 */
function Row({
  icon: Icon,
  children,
  className,
}: {
  icon: typeof MapPin;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2 text-xs", className)}>
      <Icon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** One cell of the reference block under the divider: small label, small value. */
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
        {label}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-foreground/90">
        {children}
      </span>
    </div>
  );
}

/** Placeholder for a reference field this branch has nothing in. */
function Absent() {
  return <span className="text-muted-foreground/50">—</span>;
}

function BranchCardInner({
  branch,
  selected,
  favourite,
  tokens,
  onSelect,
  onToggleFavourite,
}: Props) {
  const [copiedPhone, copyPhone] = useCopied();

  const phoneLink = telHref({ e164: branch.phoneE164, digits: branch.phoneDigits });
  const phoneValue = branch.phoneE164 ?? branch.phoneDisplay;
  const dutyLabel = branch.duty_hours != null ? dutyHoursLabel(branch.duty_hours) : null;
  const managerPhone = branch.managerPhoneE164 ?? branch.managerPhoneDisplay;
  const coordinates = branch.hasCoords ? `${branch.latitude}, ${branch.longitude}` : null;

  return (
    <article
      onClick={() => onSelect(branch.branch_no)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-card text-left shadow-sm",
        "transition-[box-shadow,border-color,transform] duration-200",
        "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/5",
        selected
          ? "border-primary/60 shadow-md ring-1 ring-primary/30"
          : "border-border/60 hover:border-primary/30",
      )}
    >
      {/* Selection accent. A left rail rather than a full tint so the card's own
          colour coding (scooter, hours) stays readable when selected. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1 bg-primary transition-opacity duration-200",
          selected ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        className="flex shrink-0 flex-col px-4 pb-3 pl-5 pt-3.5"
        style={{ height: CARD_CONTENT_HEIGHT }}
      >
        {/* Header — code and how long it opens, city beneath, delivery beside */}
        <div className="flex shrink-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-mono text-[17px] font-bold leading-6 tracking-tight text-foreground">
                <Highlight text={branch.branch_no} tokens={tokens} />
              </h3>
              {dutyLabel && (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                    branch.duty_hours != null && branch.duty_hours >= 24
                      ? "bg-[var(--badge-violet)]/12 text-[var(--badge-violet)]"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {dutyLabel}
                </span>
              )}
            </div>
            <p className="mt-px flex items-center gap-1 truncate text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
              <span className="truncate" dir="auto">
                <span className="font-medium text-foreground/80">
                  <Highlight text={branch.city} tokens={tokens} />
                </span>
                {branch.cityEnglish && (
                  <span className="opacity-70">
                    {" · "}
                    <Highlight text={branch.cityEnglish} tokens={tokens} />
                  </span>
                )}
              </span>
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <span
              title={
                branch.scooter
                  ? (branch.scooter_note ?? "Scooter delivery available")
                  : "No scooter delivery"
              }
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                branch.scooter
                  ? "bg-[var(--positive)]/12 text-[var(--positive)]"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {branch.scooter ? <Bike className="h-3 w-3" /> : <Ban className="h-3 w-3" />}
              {branch.scooter ? "Scooter" : "No scooter"}
            </span>
            <button
              type="button"
              aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={favourite}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavourite(branch.branch_no);
              }}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-lg transition-colors",
                favourite
                  ? "text-[var(--attention)]"
                  : "text-muted-foreground/40 hover:bg-accent hover:text-[var(--attention)]",
              )}
            >
              <Star className={cn("h-4 w-4", favourite && "fill-current")} />
            </button>
          </div>
        </div>

        {/* Branch phone — the number the call is about, at reading size. Copying
            and dialling it are in the action bar rather than repeated here. */}
        <div className="mt-2.5 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/40 px-2.5">
          <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
          {branch.phoneDisplay ? (
            phoneLink ? (
              <a
                href={phoneLink}
                onClick={(event) => event.stopPropagation()}
                className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground hover:text-primary hover:underline"
                dir="ltr"
              >
                <Highlight text={branch.phoneDisplay} tokens={tokens} />
              </a>
            ) : (
              <span
                className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground"
                dir="ltr"
              >
                {branch.phoneDisplay}
              </span>
            )
          ) : (
            <span className="flex-1 text-xs text-muted-foreground/70">No phone on file</span>
          )}
        </div>

        {/* Address, hours and the area manager — what an agent reads out. */}
        <div className="mt-2.5 min-h-0 flex-1 space-y-2">
          <Row icon={MapPin}>
            <span className="line-clamp-2 leading-snug text-foreground/90" dir="auto">
              {branch.address ? (
                <Highlight text={branch.address} tokens={tokens} />
              ) : (
                <span className="text-muted-foreground/70">No address on file</span>
              )}
            </span>
          </Row>

          <Row icon={Clock}>
            <span className="block truncate text-foreground/90">
              {branch.working_hours ?? (
                <span className="text-muted-foreground/70">Hours not recorded</span>
              )}
            </span>
            <span className="block truncate text-muted-foreground">
              Friday · {branch.friday_hours ?? "not recorded"}
            </span>
          </Row>

          <Row icon={UserRound}>
            <span className="block truncate text-foreground/90" dir="auto">
              {branch.area_manager ? (
                <Highlight text={branch.area_manager} tokens={tokens} />
              ) : (
                <span className="text-muted-foreground/70">No area manager</span>
              )}
            </span>
            <span className="flex items-center gap-1">
              {branch.managerPhoneDisplay ? (
                <>
                  <span
                    className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                    dir="ltr"
                  >
                    <Highlight text={branch.managerPhoneDisplay} tokens={tokens} />
                  </span>
                  <CopyButton value={managerPhone ?? ""} label="Manager phone" />
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground/70">No manager phone</span>
              )}
            </span>
          </Row>
        </div>

        {/* Reference fields. Below a divider because they are looked up rather
            than read out — but on the card, because a click to see a coordinate
            is still a click. Every cell renders even when empty, so the card's
            height stays the one the virtualizer was promised. */}
        <div className="mt-2.5 grid shrink-0 grid-cols-2 gap-x-3 gap-y-1 border-t border-border/50 pt-2.5">
          <Detail label="Coords">
            {coordinates ? (
              <>
                {/* Titled because a narrow card truncates it, and half a
                    coordinate is worse than none. */}
                <span className="min-w-0 truncate font-mono" dir="ltr" title={coordinates}>
                  {coordinates}
                </span>
                <CopyButton value={coordinates} label="Coordinates" />
              </>
            ) : (
              <Absent />
            )}
          </Detail>

          <Detail label="Updated">{formatUpdated(branch.updated_at) ?? <Absent />}</Detail>

          <Detail label="Map">
            {branch.mapsLink ? (
              <a
                href={branch.mapsLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="min-w-0 truncate text-primary hover:underline"
              >
                Google Maps
              </a>
            ) : (
              <Absent />
            )}
          </Detail>

          <Detail label="Delivery">
            {branch.scooter_note ? (
              <span className="min-w-0 truncate" dir="auto" title={branch.scooter_note}>
                {branch.scooter_note}
              </span>
            ) : (
              <Absent />
            )}
          </Detail>
        </div>

        {/* The three things agents actually do with a branch. Equal widths so the
            bar reads as one control rather than a row of odds and ends, and
            disabled rather than absent when a branch is missing the data — a
            button that moves between cards is one you have to look for. */}
        <div className="mt-2.5 grid shrink-0 grid-cols-3 gap-1.5 border-t border-border/50 pt-2.5">
          {phoneLink ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-0 px-2 text-xs"
              asChild
              onClick={(event) => event.stopPropagation()}
            >
              <a href={phoneLink}>
                <Phone className="h-3.5 w-3.5" />
                <span className="truncate">Call</span>
              </a>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled
              className="h-8 min-w-0 px-2 text-xs"
              title="No branch phone on file"
            >
              <Phone className="h-3.5 w-3.5" />
              <span className="truncate">Call</span>
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            disabled={!phoneValue}
            aria-label={copiedPhone ? "Branch phone copied" : "Copy branch phone"}
            title={phoneValue ? "Copy branch phone" : "No branch phone on file"}
            className="h-8 min-w-0 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              copyPhone(phoneValue ?? "", "Branch phone");
            }}
          >
            {copiedPhone ? (
              <Check className="h-3.5 w-3.5 text-[var(--positive)]" strokeWidth={3} />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span className="truncate">{copiedPhone ? "Copied" : "Copy"}</span>
          </Button>

          {branch.navLink ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-0 px-2 text-xs"
              asChild
              onClick={(event) => event.stopPropagation()}
            >
              <a href={branch.navLink} target="_blank" rel="noopener noreferrer">
                <Navigation className="h-3.5 w-3.5" />
                <span className="truncate">Navigate</span>
              </a>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled
              className="h-8 min-w-0 px-2 text-xs"
              title="No coordinates on file"
            >
              <Navigation className="h-3.5 w-3.5" />
              <span className="truncate">Navigate</span>
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Date only: the time of day a row was last written is not a card-level fact. */
function formatUpdated(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: BUSINESS_TIMEZONE,
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

/** Everything an agent pastes into a ticket, in one copy. */
export function contactBlock(branch: BranchView): string {
  return [
    `Branch: ${branch.branch_no}`,
    `City: ${branch.city}`,
    branch.address ? `Address: ${branch.address}` : null,
    branch.phoneDisplay ? `Phone: ${branch.phoneDisplay}` : null,
    branch.area_manager ? `Area manager: ${branch.area_manager}` : null,
    branch.managerPhoneDisplay ? `Manager phone: ${branch.managerPhoneDisplay}` : null,
    branch.working_hours ? `Hours: ${branch.working_hours}` : null,
    branch.friday_hours ? `Friday: ${branch.friday_hours}` : null,
    branch.mapsLink ? `Map: ${branch.mapsLink}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Memoized on purpose, and it is load-bearing.
 *
 * Typing a character re-renders the list container. Without this, all ~30
 * mounted cards re-render with it even though at most one changed; with it,
 * React skips every card whose branch, selection and favourite state are
 * unchanged. The callbacks passed in are all `useCallback`-stable, and the token
 * array is `useMemo`-stable, for the same reason.
 */
export const BranchCard = memo(BranchCardInner);

/** Placeholder shown while the directory loads, sized to match a real card. */
export function BranchCardSkeleton() {
  return (
    <div
      className="animate-pulse rounded-2xl border border-border/60 bg-card px-4 pb-3 pl-5 pt-3.5"
      style={{ height: CARD_HEIGHT }}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-4 w-20 rounded bg-muted" />
          <div className="h-3 w-28 rounded bg-muted/70" />
        </div>
        <div className="h-5 w-20 rounded-full bg-muted/70" />
      </div>
      <div className="mt-3 h-9 rounded-lg bg-muted/50" />
      <div className="mt-3 space-y-2.5">
        <div className="h-3 w-full rounded bg-muted/70" />
        <div className="h-3 w-4/5 rounded bg-muted/70" />
        <div className="h-3 w-2/3 rounded bg-muted/70" />
        <div className="h-3 w-1/2 rounded bg-muted/70" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="h-3 rounded bg-muted/70" />
        <div className="h-3 rounded bg-muted/70" />
        <div className="h-3 rounded bg-muted/70" />
        <div className="h-3 rounded bg-muted/70" />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-1.5">
        <div className="h-8 rounded bg-muted/70" />
        <div className="h-8 rounded bg-muted/70" />
        <div className="h-8 rounded bg-muted/70" />
      </div>
    </div>
  );
}
