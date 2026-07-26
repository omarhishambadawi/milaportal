import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Bike,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Mail,
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
 * Collapsed card height, in pixels.
 *
 * A single fixed number, and the virtualizer depends on it being true: every
 * row position is computed from it rather than measured. That is why the address
 * below is line-clamped and every meta row has a fixed height — a card that grew
 * to fit a long address would silently desynchronize the whole list's scroll
 * geometry.
 *
 * It grew from 244px when the card stopped hiding operational data behind the
 * expander. Everything an agent reads out during a call — code, city, address,
 * branch phone, weekday and Friday hours, scooter status, area manager and the
 * manager's mobile — is on the face of the card now, which is nine fields rather
 * than five and needs the height. The trade pays for itself twice over: the map
 * shrank from half the split to a quarter, so the list is wide enough for a
 * second and often a third column.
 */
export const CARD_HEIGHT = 300;

/**
 * The card's 1px border, top and bottom.
 *
 * Subtracted from the inner section's height so that CARD_HEIGHT is the card's
 * *outer* height — which is what the virtualizer positions rows by. Without
 * this the article measures 302px in a 300px slot, and every gap in the list is
 * quietly 2px short of the one the layout asks for.
 */
const CARD_BORDER = 2;

/** Height of the collapsed content area, inside the border. */
export const CARD_CONTENT_HEIGHT = CARD_HEIGHT - CARD_BORDER;

/** Minimum width one card needs before a second column is worth it. */
export const CARD_MIN_WIDTH = 340;

interface Props {
  branch: BranchView;
  expanded: boolean;
  selected: boolean;
  favourite: boolean;
  /** Folded query tokens, for highlighting what matched. */
  tokens: readonly string[];
  onToggleExpand: (branchNo: string) => void;
  onSelect: (branchNo: string) => void;
  onToggleFavourite: (branchNo: string) => void;
  /** Reports the height the open panel adds, so the list can lay out around it. */
  onMeasureExpanded?: (height: number) => void;
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
        "grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors",
        copied
          ? "text-[var(--positive)]"
          : "text-muted-foreground/60 hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/**
 * One line of the card's face.
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

function DetailRow({
  label,
  value,
  onCopy,
  href,
}: {
  label: string;
  value: string | null;
  onCopy?: () => void;
  href?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {value ? (
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-xs text-primary hover:underline"
            >
              {value}
            </a>
          ) : (
            <span className="truncate text-xs text-foreground/90" dir="auto">
              {value}
            </span>
          )
        ) : (
          <span className="text-xs text-muted-foreground/60">—</span>
        )}
        {value && onCopy && (
          <button
            type="button"
            onClick={onCopy}
            aria-label={`Copy ${label}`}
            className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
      </span>
    </div>
  );
}

function BranchCardInner({
  branch,
  expanded,
  selected,
  favourite,
  tokens,
  onToggleExpand,
  onSelect,
  onToggleFavourite,
  onMeasureExpanded,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [copiedAll, copyAll] = useCopied();

  // The virtualizer needs the open panel's real height to position every row
  // below it. Measured rather than assumed because the panel's content varies:
  // a branch with no coordinates renders fewer rows than one with them.
  useEffect(() => {
    if (!expanded || !panelRef.current || !onMeasureExpanded) return;
    const element = panelRef.current;
    const report = () => onMeasureExpanded(element.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, onMeasureExpanded]);

  const phoneLink = telHref({ e164: branch.phoneE164, digits: branch.phoneDigits });
  const dutyLabel = branch.duty_hours != null ? dutyHoursLabel(branch.duty_hours) : null;
  const managerPhone = branch.managerPhoneE164 ?? branch.managerPhoneDisplay;

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
        {/* Header — code and city, with the two status facts beside them */}
        <div className="flex shrink-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-mono text-[17px] font-bold leading-6 tracking-tight text-foreground">
              <Highlight text={branch.branch_no} tokens={tokens} />
            </h3>
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

        {/* Branch phone — the single most-copied value on the page, so it gets a
            row of its own at reading size instead of a footnote in the footer. */}
        <div className="mt-2.5 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/40 pl-2.5 pr-1">
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
              <CopyButton value={branch.phoneE164 ?? branch.phoneDisplay} label="Branch phone" />
            </>
          ) : (
            <span className="flex-1 text-xs text-muted-foreground/70">No phone on file</span>
          )}
        </div>

        {/* Address, hours and the area manager — every field an agent reads out
            during a call, none of it behind an expander. */}
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
                  <CopyButton
                    value={managerPhone ?? ""}
                    label="Manager phone"
                    className="h-5 w-5"
                  />
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground/70">No manager phone</span>
              )}
            </span>
          </Row>
        </div>

        {/* Actions. Labelled rather than a row of bare icons: "what does this
            one do" is a question nobody should have to answer mid-call. */}
        <div className="mt-2 flex shrink-0 items-center gap-1.5 border-t border-border/50 pt-2.5">
          {dutyLabel && (
            <span
              className={cn(
                "mr-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                branch.duty_hours != null && branch.duty_hours >= 24
                  ? "bg-[var(--badge-violet)]/12 text-[var(--badge-violet)]"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {dutyLabel}
            </span>
          )}

          <Button
            variant="outline"
            size="sm"
            className={cn("h-8 shrink-0 px-2.5 text-xs", !dutyLabel && "mr-auto")}
            onClick={(event) => {
              event.stopPropagation();
              copyAll(contactBlock(branch), "Branch details");
            }}
          >
            {copiedAll ? (
              <Check className="h-3.5 w-3.5 text-[var(--positive)]" strokeWidth={3} />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copiedAll ? "Copied" : "Copy details"}
          </Button>

          {branch.mapsLink && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Open in Google Maps"
              title="Open in Google Maps"
              asChild
              onClick={(event) => event.stopPropagation()}
            >
              <a href={branch.mapsLink} target="_blank" rel="noopener noreferrer">
                <MapPin className="h-4 w-4" />
              </a>
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            title={expanded ? "Hide extra details" : "Show extra details"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand(branch.branch_no);
            }}
          >
            More
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </Button>
        </div>
      </div>

      {/* Secondary data only: things a call rarely needs, and never needs fast. */}
      {expanded && (
        <div
          ref={panelRef}
          className="border-t border-border/60 bg-muted/30 px-5 py-3 animate-in fade-in slide-in-from-top-1 duration-200"
        >
          <div className="divide-y divide-border/50">
            <DetailRow
              label="Email"
              value={branch.email}
              href={branch.email ? `mailto:${branch.email}` : null}
              onCopy={() => copyText(branch.email ?? "", "Email")}
            />
            <DetailRow
              label="Coordinates"
              value={branch.hasCoords ? `${branch.latitude}, ${branch.longitude}` : null}
              onCopy={() => copyText(`${branch.latitude}, ${branch.longitude}`, "Coordinates")}
            />
            <DetailRow
              label="Maps link"
              value={branch.mapsLink}
              href={branch.mapsLink}
              onCopy={() => copyText(branch.mapsLink ?? "", "Maps link")}
            />
            {branch.scooter_note && <DetailRow label="Delivery note" value={branch.scooter_note} />}
            <DetailRow label="Last updated" value={formatUpdated(branch.updated_at)} />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {branch.navLink && (
              <Button size="sm" variant="outline" className="h-8" asChild>
                <a
                  href={branch.navLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Navigation className="h-3.5 w-3.5" />
                  Navigate
                </a>
              </Button>
            )}
            {branch.mapsLink && (
              <Button size="sm" variant="outline" className="h-8" asChild>
                <a
                  href={branch.mapsLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Google Maps
                </a>
              </Button>
            )}
            {branch.email && (
              <Button size="sm" variant="outline" className="h-8" asChild>
                <a href={`mailto:${branch.email}`} onClick={(event) => event.stopPropagation()}>
                  <Mail className="h-3.5 w-3.5" />
                  Email
                </a>
              </Button>
            )}
          </div>
        </div>
      )}
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
    branch.email ? `Email: ${branch.email}` : null,
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
 * React skips every card whose branch, expansion, selection and favourite state
 * are unchanged. The callbacks passed in are all `useCallback`-stable, and the
 * token array is `useMemo`-stable, for the same reason.
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
      <div className="mt-5 flex items-center justify-between">
        <div className="h-5 w-16 rounded-full bg-muted/70" />
        <div className="h-8 w-32 rounded bg-muted/70" />
      </div>
    </div>
  );
}
