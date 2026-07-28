import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Bike,
  Check,
  Copy,
  ExternalLink,
  Info,
  MapPin,
  Navigation,
  Pencil,
  Phone,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyText } from "../clipboard";
import { Highlight } from "../highlight";
import { REFERENCE_LABEL, dutyHoursLabel, telHref } from "../normalize";
import type { BranchView } from "../types";

/**
 * Card height, in pixels.
 *
 * A single fixed number, and the virtualizer depends on it being true: every row
 * position is computed from it rather than measured. That is why the address is
 * clamped and every other row is one line tall — a card that grew to fit its
 * content would silently desynchronize the whole list's scroll geometry.
 *
 * It had grown to 520 across successive passes that each took something out of
 * hiding, and at that size a 1080p screen holds one and a half rows of cards.
 * This pass went the other way: the labelled sections became a single definition
 * grid, the two headings-per-group disappeared, and the fields that repeated
 * something already on the card (the district, which is the first half of the
 * address; the delivery note, which is the scooter badge's tooltip; the
 * last-updated date, which the page header already reports for the whole
 * directory) came out. Same information, roughly two thirds the height.
 *
 * The number is not arbitrary: the six definition rows and the two-line address
 * measure 158px, and a reference location spends a further 32 on its banner. 348
 * leaves both cases a dozen pixels of slack, which is what keeps the last row
 * from being clipped by the card's own `overflow-hidden` if a font renders a
 * fraction taller than expected.
 */
export const CARD_HEIGHT = 348;

/**
 * The card's 1px border, top and bottom.
 *
 * Subtracted from the inner section's height so that CARD_HEIGHT is the card's
 * *outer* height — which is what the virtualizer positions rows by. Without this
 * the article measures 350px in a 348px slot, and every gap in the list is
 * quietly 2px short of the one the layout asks for.
 */
const CARD_BORDER = 2;

/** Height of the content area, inside the border. */
export const CARD_CONTENT_HEIGHT = CARD_HEIGHT - CARD_BORDER;

/** Minimum width one card needs before a second column is worth it. */
export const CARD_MIN_WIDTH = 320;

/**
 * Lines the address may take before it clamps.
 *
 * Two rather than the old three, because the address no longer repeats the city
 * that the header states directly above it — `addressLine` is the district and
 * the street, which fits in two lines at every column width. The box is always
 * two lines tall rather than growing into them, because the virtualizer needs
 * this card's height to be knowable without measuring it. The full text is on
 * the element's `title` and one copy button away regardless.
 */
const ADDRESS_LINES = 2;

/** Line height of the card's body text, in pixels. Matches `leading-[15px]`. */
const ADDRESS_LINE_HEIGHT = 15;

interface Props {
  branch: BranchView;
  selected: boolean;
  favourite: boolean;
  /** Folded query tokens, for highlighting what matched. */
  tokens: readonly string[];
  /** Whether this user may correct a branch in place. */
  canEdit?: boolean;
  onSelect: (branchNo: string) => void;
  onToggleFavourite: (branchNo: string) => void;
  onEdit?: (branch: BranchView) => void;
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
        "grid h-5 w-5 shrink-0 place-items-center rounded-md transition-colors",
        copied
          ? "text-[var(--positive)]"
          : "text-muted-foreground/70 hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {copied ? <Check className="h-3 w-3" strokeWidth={3} /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/**
 * One labelled value, optionally with its own copy button.
 *
 * A three-column grid rather than a flex row so that the labels of every field
 * line up down the card — the thing that lets an agent find the hours without
 * reading the rows above them. The section headings this replaces cost a line
 * each and said nothing a two-word label to the left of the value does not.
 */
function Field({
  label,
  children,
  copy,
  className,
}: {
  label: string;
  children: React.ReactNode;
  copy?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[3.5rem_minmax(0,1fr)_1.25rem] items-start gap-x-2 py-1",
        className,
      )}
    >
      <span className="pt-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
  canEdit,
  onSelect,
  onToggleFavourite,
  onEdit,
}: Props) {
  const phoneLink = telHref({ e164: branch.phoneE164, digits: branch.phoneDigits });
  // Copy what is on screen. An agent who presses this is about to paste the
  // number into a dialler or a ticket, and handing them a different string from
  // the one they just read is how a transcription error gets blamed on the tool.
  const phoneValue = branch.phoneDisplay;
  const dutyLabel = branch.duty_hours != null ? dutyHoursLabel(branch.duty_hours) : null;
  const managerPhone = branch.managerPhoneDisplay;
  const coordinates = branch.hasCoords ? `${branch.latitude}, ${branch.longitude}` : null;
  const referenceLabel = branch.reference ? REFERENCE_LABEL[branch.reference] : null;
  const isReference = referenceLabel != null;

  return (
    <article
      onClick={() => onSelect(branch.branch_no)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border text-left",
        "bg-card shadow-sm dark:shadow-none dark:ring-1 dark:ring-inset dark:ring-white/[0.04]",
        "transition-[box-shadow,border-color,transform] duration-200",
        "hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/5",
        "dark:hover:bg-card/80 dark:hover:ring-white/10",
        selected
          ? "border-primary/60 shadow-md ring-1 ring-primary/30 dark:ring-primary/40"
          : "border-border/60 hover:border-primary/30",
      )}
    >
      {/* Selection accent. A left rail rather than a full tint so the card's own
          colour coding (scooter, hours, reference) stays readable when selected. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1 transition-opacity duration-200",
          isReference ? "bg-[var(--attention)]" : "bg-primary",
          selected || isReference ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        className="flex shrink-0 flex-col px-3 pb-2.5 pl-4 pt-2.5"
        style={{ height: CARD_CONTENT_HEIGHT }}
      >
        {/* HEADER — code, how long it opens, city, delivery, favourite */}
        <div className="flex shrink-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate font-mono text-[15px] font-bold leading-5 tracking-tight text-foreground">
                <Highlight text={branch.branch_no} tokens={tokens} />
              </h3>
              {dutyLabel && !isReference && (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold",
                    branch.duty_hours != null && branch.duty_hours >= 24
                      ? "bg-[var(--badge-violet)]/12 text-[var(--badge-violet)]"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {dutyLabel}
                </span>
              )}
            </div>
            <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
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

          <div className="flex shrink-0 items-center gap-0.5">
            {!isReference && (
              <span
                title={
                  branch.scooter
                    ? (branch.scooter_note ?? "Scooter delivery available")
                    : "No scooter delivery"
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold",
                  branch.scooter
                    ? "bg-[var(--positive)]/12 text-[var(--positive)]"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {branch.scooter ? <Bike className="h-3 w-3" /> : <Ban className="h-3 w-3" />}
                {branch.scooter ? "Scooter" : "None"}
              </span>
            )}
            {canEdit && onEdit && (
              <button
                type="button"
                aria-label={`Edit branch ${branch.branch_no}`}
                title="Edit this branch"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(branch);
                }}
                className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={favourite}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavourite(branch.branch_no);
              }}
              className={cn(
                "grid h-6 w-6 place-items-center rounded-md transition-colors",
                favourite
                  ? "text-[var(--attention)]"
                  : "text-muted-foreground/40 hover:bg-accent hover:text-[var(--attention)]",
              )}
            >
              <Star className={cn("h-4 w-4", favourite && "fill-current")} />
            </button>
          </div>
        </div>

        {/* NOT A BRANCH. Head office, the regional office and the warehouses are
            in this directory because agents need their switchboard and their
            address — never because a customer should be sent to one. The badge
            is the whole point of this row, so it is above the phone number
            rather than tucked in beside the code. */}
        {isReference && (
          <div className="mt-2 flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-[var(--attention)]/30 bg-[var(--attention)]/10 px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--attention)]">
            <Info className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">Reference location · {referenceLabel}</span>
          </div>
        )}

        {/* CONTACT — the number the call is about, at reading size. No label: a
            phone number in mono next to a handset icon is not a thing anyone has
            to have labelled. */}
        <div className="mt-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/40 px-2 dark:bg-muted/25">
          <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
          {branch.phoneDisplay ? (
            <>
              {phoneLink ? (
                <a
                  href={phoneLink}
                  onClick={(event) => event.stopPropagation()}
                  className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-foreground hover:text-primary hover:underline"
                  dir="ltr"
                >
                  <Highlight text={branch.phoneDisplay} tokens={tokens} />
                </a>
              ) : (
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-foreground"
                  dir="ltr"
                >
                  {branch.phoneDisplay}
                </span>
              )}
              <CopyButton value={phoneValue ?? ""} label="Branch phone" />
            </>
          ) : (
            <span className="flex-1 text-[11px] text-muted-foreground">No phone on file</span>
          )}
        </div>

        {/* Everything else, as one definition list. The District field that used
            to lead this block is gone: it was extracted from the first half of
            the address and then printed directly above it, so the card said the
            same words twice. */}
        <div className="mt-1.5 min-h-0 flex-1 divide-y divide-border/40">
          <Field
            label="Address"
            copy={
              branch.addressLine ? (
                <CopyButton value={branch.address ?? branch.addressLine} label="Address" />
              ) : undefined
            }
          >
            {/* The box is always two lines tall, not "up to two". Reserving the
                space rather than growing into it is what keeps every card
                exactly CARD_HEIGHT at every column width — the same address
                wraps to one line in a wide column and two in a narrow one, and a
                card that grew by a line when the map panel was dragged would
                desynchronize the list's scroll geometry. */}
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
              {branch.addressLine ? (
                <Highlight text={branch.addressLine} tokens={tokens} />
              ) : (
                <Absent />
              )}
            </span>
          </Field>

          <Field label="Hours">
            <span className="block truncate" title={branch.working_hours ?? undefined}>
              {branch.working_hours ?? <Absent />}
            </span>
          </Field>

          <Field label="Friday">
            <span className="block truncate" title={branch.friday_hours ?? undefined}>
              {branch.friday_hours ?? <Absent />}
            </span>
          </Field>

          <Field
            label="Manager"
            copy={
              managerPhone ? <CopyButton value={managerPhone} label="Manager phone" /> : undefined
            }
          >
            {branch.area_manager || branch.managerPhoneDisplay ? (
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span
                  className="min-w-0 flex-1 truncate"
                  dir="auto"
                  title={branch.area_manager ?? undefined}
                >
                  {branch.area_manager ? (
                    <Highlight text={branch.area_manager} tokens={tokens} />
                  ) : (
                    <Absent />
                  )}
                </span>
                {branch.managerPhoneDisplay && (
                  <span className="shrink-0 font-mono text-muted-foreground" dir="ltr">
                    <Highlight text={branch.managerPhoneDisplay} tokens={tokens} />
                  </span>
                )}
              </span>
            ) : (
              <Absent />
            )}
          </Field>

          {/* MAP — a short label rather than the URL itself. Nobody reads a
              Google Maps link and nobody types one back in; the two things
              anyone does with it are open it and copy it, and both are one
              control away. Printing 200 characters of query string to say
              "there is a link" was three lines of the old card. */}
          <Field
            label="Map"
            copy={
              branch.mapsLink ? <CopyButton value={branch.mapsLink} label="Maps link" /> : undefined
            }
          >
            {branch.mapsLink ? (
              <a
                href={branch.mapsLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                title={branch.mapsLink}
                className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                dir="ltr"
              >
                <span className="truncate">{branch.mapsLabel ?? "Google Maps"}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              </a>
            ) : (
              <Absent />
            )}
          </Field>

          <Field
            label="Coords"
            copy={coordinates ? <CopyButton value={coordinates} label="Coordinates" /> : undefined}
          >
            {coordinates ? (
              <span className="block truncate font-mono" dir="ltr" title={coordinates}>
                {coordinates}
              </span>
            ) : (
              <Absent />
            )}
          </Field>
        </div>

        {/* The two things agents do with a branch that are not a copy. The third
            button that used to sit here copied the branch phone — the same value
            the handset row already copies, two inches above it. */}
        <div className="mt-1.5 grid shrink-0 grid-cols-2 gap-1.5 border-t border-border/50 pt-2">
          {phoneLink ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 min-w-0 px-2 text-xs"
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
              className="h-7 min-w-0 px-2 text-xs"
              title="No branch phone on file"
            >
              <Phone className="h-3.5 w-3.5" />
              <span className="truncate">Call</span>
            </Button>
          )}

          {branch.navLink ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 min-w-0 px-2 text-xs"
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
              className="h-7 min-w-0 px-2 text-xs"
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

/** Everything an agent pastes into a ticket, in one copy. */
export function contactBlock(branch: BranchView): string {
  return [
    `Branch: ${branch.branch_no}`,
    branch.reference ? `Type: ${REFERENCE_LABEL[branch.reference]} (not a pharmacy)` : null,
    `City: ${branch.city}`,
    branch.addressLine ? `Address: ${branch.addressLine}` : null,
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
      className="animate-pulse rounded-xl border border-border/60 bg-card px-3 pb-2.5 pl-4 pt-2.5"
      style={{ height: CARD_HEIGHT }}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <div className="h-4 w-20 rounded bg-muted" />
          <div className="h-3 w-28 rounded bg-muted/70" />
        </div>
        <div className="h-4 w-16 rounded-full bg-muted/70" />
      </div>
      <div className="mt-2 h-8 rounded-lg bg-muted/50" />
      <div className="mt-2 space-y-2">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div key={row} className="flex items-center gap-2">
            <div className="h-2.5 w-12 shrink-0 rounded bg-muted/60" />
            <div className="h-2.5 flex-1 rounded bg-muted/70" />
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-1.5">
        <div className="h-7 rounded bg-muted/70" />
        <div className="h-7 rounded bg-muted/70" />
      </div>
    </div>
  );
}
