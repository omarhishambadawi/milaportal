import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Bike,
  Check,
  Clock,
  Copy,
  ExternalLink,
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
 * A single fixed number, and the virtualizer depends on it being true: every row
 * position is computed from it rather than measured. That is why the address is
 * clamped at three lines and every other row has a fixed height — a card that
 * grew to fit its content would silently desynchronize the whole list's scroll
 * geometry.
 *
 * It has grown with every pass that took something out of hiding, and this one
 * grouped what was left into labelled sections: contact, location, hours, area
 * manager, map. Nothing about a branch costs a click, and every value an agent
 * reads to a customer has its own copy button.
 */
export const CARD_HEIGHT = 520;

/**
 * The card's 1px border, top and bottom.
 *
 * Subtracted from the inner section's height so that CARD_HEIGHT is the card's
 * *outer* height — which is what the virtualizer positions rows by. Without this
 * the article measures 522px in a 520px slot, and every gap in the list is
 * quietly 2px short of the one the layout asks for.
 */
const CARD_BORDER = 2;

/** Height of the content area, inside the border. */
export const CARD_CONTENT_HEIGHT = CARD_HEIGHT - CARD_BORDER;

/** Minimum width one card needs before a second column is worth it. */
export const CARD_MIN_WIDTH = 340;

/**
 * Lines the address may take before it clamps.
 *
 * Three, which is enough for every address in the current sheet at every column
 * width — the longest wraps to two in a wide column and three in a narrow one.
 * The box is always three lines tall rather than growing into them, because the
 * virtualizer needs this card's height to be knowable without measuring it. The
 * full text is on the element's `title` and one copy button away regardless.
 */
const ADDRESS_LINES = 3;

/** Line height of the card's body text, in pixels. Matches `leading-[15px]`. */
const ADDRESS_LINE_HEIGHT = 15;

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

/** Per-value copy. Every field an agent dictates has one of these. */
function CopyButton({ value, label }: { value: string; label: string }) {
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
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {copied ? <Check className="h-3 w-3" strokeWidth={3} /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/** A group of related fields, under a quiet heading. */
function Section({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: string;
  icon: typeof MapPin;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <h4 className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        <Icon className="h-3 w-3 opacity-80" aria-hidden />
        {title}
      </h4>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

/**
 * One labelled value, optionally with its own copy button.
 *
 * A three-column grid rather than a flex row so that the labels of every field
 * in every section line up down the card — the thing that lets an agent find
 * "District" without reading the ones above it.
 */
function Field({
  label,
  children,
  copy,
}: {
  label: string;
  children: React.ReactNode;
  copy?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[3.75rem_minmax(0,1fr)_1.25rem] items-start gap-x-2">
      <span className="pt-[2px] text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 text-[11px] leading-[15px] text-foreground/90">{children}</div>
      {copy ?? <span aria-hidden />}
    </div>
  );
}

/** Placeholder for a field this branch has nothing in. */
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
        {/* HEADER — code, how long it opens, city, delivery, favourite */}
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

        {/* CONTACT — the number the call is about, at reading size. No section
            heading: a phone number at 14px mono next to a handset icon is not a
            thing anyone has to have labelled. */}
        <div className="mt-2.5 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/40 px-2.5">
          <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
          {branch.phoneDisplay ? (
            <>
              {phoneLink ? (
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
              )}
              <CopyButton value={phoneValue ?? ""} label="Branch phone" />
            </>
          ) : (
            <span className="flex-1 text-xs text-muted-foreground">No phone on file</span>
          )}
        </div>

        <div className="mt-2.5 min-h-0 flex-1 space-y-2.5">
          {/* LOCATION — district first: it is the part an agent says out loud
              when a customer asks where the branch is. */}
          <Section title="Location" icon={MapPin}>
            <Field
              label="District"
              copy={
                branch.district ? (
                  <CopyButton value={branch.district} label="District" />
                ) : undefined
              }
            >
              {branch.district ? (
                <span className="block truncate font-medium" dir="auto" title={branch.district}>
                  <Highlight text={branch.district} tokens={tokens} />
                </span>
              ) : (
                <Absent />
              )}
            </Field>

            <Field
              label="Address"
              copy={
                branch.address ? <CopyButton value={branch.address} label="Address" /> : undefined
              }
            >
              {/* The box is always three lines tall, not "up to three".
                  Reserving the space rather than growing into it is what keeps
                  every card exactly CARD_HEIGHT at every column width — the same
                  address wraps to two lines in a wide column and three in a
                  narrow one, and a card that grew by a line when the map panel
                  was dragged would desynchronize the list's scroll geometry. */}
              <span
                className="block break-words"
                style={{
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: ADDRESS_LINES,
                  overflow: "hidden",
                  height: ADDRESS_LINES * ADDRESS_LINE_HEIGHT,
                }}
                dir="auto"
                title={branch.address ?? undefined}
              >
                {branch.address ? <Highlight text={branch.address} tokens={tokens} /> : <Absent />}
              </span>
            </Field>
          </Section>

          {/* WORKING HOURS — side by side rather than stacked. Both values are
              short and fixed-shape ("07 AM - 03 AM"), and an agent comparing the
              weekday line to the Friday one wants them on the same eye line. */}
          <Section title="Working hours" icon={Clock}>
            <div className="grid grid-cols-2 gap-x-2">
              <div className="min-w-0">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Weekdays
                </span>
                <span
                  className="block truncate text-[11px] leading-[15px] text-foreground/90"
                  title={branch.working_hours ?? undefined}
                >
                  {branch.working_hours ?? <Absent />}
                </span>
              </div>
              <div className="min-w-0">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Friday
                </span>
                <span
                  className="block truncate text-[11px] leading-[15px] text-foreground/90"
                  title={branch.friday_hours ?? undefined}
                >
                  {branch.friday_hours ?? <Absent />}
                </span>
              </div>
            </div>
          </Section>

          {/* AREA MANAGER */}
          <Section title="Area manager" icon={UserRound}>
            <Field label="Name">
              {branch.area_manager ? (
                <span className="block truncate" dir="auto" title={branch.area_manager}>
                  <Highlight text={branch.area_manager} tokens={tokens} />
                </span>
              ) : (
                <Absent />
              )}
            </Field>
            <Field
              label="Phone"
              copy={
                managerPhone ? <CopyButton value={managerPhone} label="Manager phone" /> : undefined
              }
            >
              {branch.managerPhoneDisplay ? (
                <span className="block truncate font-mono" dir="ltr">
                  <Highlight text={branch.managerPhoneDisplay} tokens={tokens} />
                </span>
              ) : (
                <Absent />
              )}
            </Field>
          </Section>

          {/* MAP — the link in full, and the coordinates as one copyable pair */}
          <Section
            title="Map & coordinates"
            icon={Navigation}
            className="border-t border-border/50 pt-2.5"
          >
            <Field
              label="Link"
              copy={
                branch.mapsLink ? (
                  <CopyButton value={branch.mapsLink} label="Maps link" />
                ) : undefined
              }
            >
              {branch.mapsLink ? (
                <a
                  href={branch.mapsLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  title={branch.mapsLink}
                  className="inline-flex max-w-full items-start gap-1 text-primary hover:underline"
                  dir="ltr"
                >
                  <span
                    className="min-w-0 break-all"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                    }}
                  >
                    {branch.mapsLink}
                  </span>
                  <ExternalLink className="mt-[2px] h-3 w-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <Absent />
              )}
            </Field>
            <Field
              label="Coords"
              copy={
                coordinates ? <CopyButton value={coordinates} label="Coordinates" /> : undefined
              }
            >
              {coordinates ? (
                <span className="block truncate font-mono" dir="ltr" title={coordinates}>
                  {coordinates}
                </span>
              ) : (
                <Absent />
              )}
            </Field>
          </Section>
        </div>

        {/* Delivery note and freshness: the two things nobody dictates, on one
            quiet line rather than in a section of their own. */}
        <div className="mt-2 flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" dir="auto" title={branch.scooter_note ?? ""}>
            {branch.scooter_note ? `Delivery · ${branch.scooter_note}` : "No delivery note"}
          </span>
          {formatUpdated(branch.updated_at) && (
            <span className="shrink-0">Updated {formatUpdated(branch.updated_at)}</span>
          )}
        </div>

        {/* The three things agents actually do with a branch. Equal widths so the
            bar reads as one control rather than a row of odds and ends, and
            disabled rather than absent when a branch is missing the data — a
            button that moves between cards is one you have to look for. */}
        <div className="mt-2 grid shrink-0 grid-cols-3 gap-1.5 border-t border-border/50 pt-2.5">
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
    branch.district ? `District: ${branch.district}` : null,
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
      {[0, 1, 2, 3].map((section) => (
        <div key={section} className="mt-3 space-y-1.5">
          <div className="h-2 w-16 rounded bg-muted/60" />
          <div className="h-3 w-full rounded bg-muted/70" />
          <div className="h-3 w-3/4 rounded bg-muted/70" />
        </div>
      ))}
      <div className="mt-4 grid grid-cols-3 gap-1.5">
        <div className="h-8 rounded bg-muted/70" />
        <div className="h-8 rounded bg-muted/70" />
        <div className="h-8 rounded bg-muted/70" />
      </div>
    </div>
  );
}
