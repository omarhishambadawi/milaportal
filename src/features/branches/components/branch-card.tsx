import { memo, useEffect, useRef } from "react";
import {
  Bike,
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
import { cn } from "@/lib/utils";
import { copyText } from "../clipboard";
import { dutyHoursLabel, telHref } from "../normalize";
import type { BranchView } from "../types";

/**
 * Collapsed card height, in pixels.
 *
 * A single fixed number, and the virtualizer depends on it being true: every
 * row position is computed from it rather than measured. That is why the
 * address below is line-clamped and the meta rows have fixed heights — a card
 * that grew to fit a long address would silently desynchronize the whole list's
 * scroll geometry.
 */
export const CARD_HEIGHT = 244;

/**
 * The card's 1px border, top and bottom.
 *
 * Subtracted from the inner section's height so that CARD_HEIGHT is the card's
 * *outer* height — which is what the virtualizer positions rows by. Without
 * this the article measures 246px in a 244px slot, and every gap in the list is
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
  onToggleExpand: (branchNo: string) => void;
  onSelect: (branchNo: string) => void;
  onToggleFavourite: (branchNo: string) => void;
  /** Reports the height the open panel adds, so the list can lay out around it. */
  onMeasureExpanded?: (height: number) => void;
}

function Meta({
  icon: Icon,
  children,
  className,
}: {
  icon: typeof MapPin;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
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
  onToggleExpand,
  onSelect,
  onToggleFavourite,
  onMeasureExpanded,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <article
      onClick={() => onSelect(branch.branch_no)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-card text-left shadow-sm",
        "transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-px hover:shadow-md",
        selected
          ? "border-primary/60 shadow-md ring-1 ring-primary/30"
          : "border-border/60 hover:border-border",
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

      <div className="flex shrink-0 flex-col p-4 pl-5" style={{ height: CARD_CONTENT_HEIGHT }}>
        {/* Header — code, city, star */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-mono text-base font-bold tracking-tight text-foreground">
                {branch.branch_no}
              </h3>
              {branch.scooter && (
                <span
                  title={branch.scooter_note ?? "Scooter delivery available"}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--positive)]/12 px-2 py-0.5 text-[10px] font-semibold text-[var(--positive)]"
                >
                  <Bike className="h-3 w-3" />
                  Scooter
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="auto">
              <span className="font-medium text-foreground/80">{branch.city}</span>
              {branch.cityEnglish && <span className="opacity-70"> · {branch.cityEnglish}</span>}
            </p>
          </div>

          <button
            type="button"
            aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
            aria-pressed={favourite}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavourite(branch.branch_no);
            }}
            className={cn(
              "shrink-0 rounded-lg p-1.5 transition-colors",
              favourite
                ? "text-[var(--attention)]"
                : "text-muted-foreground/40 hover:bg-accent hover:text-[var(--attention)]",
            )}
          >
            <Star className={cn("h-4 w-4", favourite && "fill-current")} />
          </button>
        </div>

        {/* Body — the three facts an agent reads out loud */}
        <div className="mt-3 space-y-2">
          <Meta icon={MapPin}>
            <span className="line-clamp-2 leading-snug" dir="auto">
              {branch.address ?? "No address on file"}
            </span>
          </Meta>
          <Meta icon={Clock}>
            <span className="block truncate">{branch.working_hours ?? "Hours not recorded"}</span>
            {branch.friday_hours && (
              <span className="block truncate opacity-75">Friday · {branch.friday_hours}</span>
            )}
          </Meta>
          <Meta icon={UserRound}>
            <span className="block truncate">{branch.area_manager ?? "No area manager"}</span>
          </Meta>
        </div>

        {/* Footer — status chips left, quick actions right */}
        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          <div className="flex min-w-0 items-center gap-1.5">
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
            {branch.phoneDisplay && (
              <span className="truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
                {branch.phoneDisplay}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {phoneLink && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Copy branch phone"
                title="Copy branch phone"
                onClick={(event) => {
                  event.stopPropagation();
                  copyText(branch.phoneE164 ?? branch.phoneDigits, "Branch phone");
                }}
              >
                <Phone className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Copy branch code"
              title="Copy branch code"
              onClick={(event) => {
                event.stopPropagation();
                copyText(branch.branch_no, "Branch code");
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            {branch.mapsLink && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Open in Google Maps"
                title="Open in Google Maps"
                asChild
                onClick={(event) => event.stopPropagation()}
              >
                <a href={branch.mapsLink} target="_blank" rel="noopener noreferrer">
                  <MapPin className="h-3.5 w-3.5" />
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={expanded ? "Hide details" : "Show details"}
              aria-expanded={expanded}
              title={expanded ? "Hide details" : "Show details"}
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpand(branch.branch_no);
              }}
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform duration-200",
                  expanded && "rotate-180",
                )}
              />
            </Button>
          </div>
        </div>
      </div>

      {expanded && (
        <div
          ref={panelRef}
          className="border-t border-border/60 bg-muted/30 px-5 py-3 animate-in fade-in slide-in-from-top-1 duration-200"
        >
          <div className="divide-y divide-border/50">
            <DetailRow
              label="Full address"
              value={branch.address}
              onCopy={() => copyText(branch.address ?? "", "Address")}
            />
            <DetailRow
              label="Email"
              value={branch.email}
              href={branch.email ? `mailto:${branch.email}` : null}
              onCopy={() => copyText(branch.email ?? "", "Email")}
            />
            <DetailRow label="Area manager" value={branch.area_manager} />
            <DetailRow
              label="Manager phone"
              value={branch.managerPhoneDisplay}
              onCopy={() =>
                copyText(
                  branch.managerPhoneE164 ?? branch.managerPhoneDisplay ?? "",
                  "Manager phone",
                )
              }
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
            {branch.scooter_note && <DetailRow label="Delivery" value={branch.scooter_note} />}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={(event) => {
                event.stopPropagation();
                copyText(contactBlock(branch), "Contact details");
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy all contacts
            </Button>
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
 * are unchanged. The callbacks passed in are all `useCallback`-stable for the
 * same reason.
 */
export const BranchCard = memo(BranchCardInner);

/** Placeholder shown while the directory loads, sized to match a real card. */
export function BranchCardSkeleton() {
  return (
    <div
      className="animate-pulse rounded-2xl border border-border/60 bg-card p-4 pl-5"
      style={{ height: CARD_HEIGHT }}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-4 w-20 rounded bg-muted" />
          <div className="h-3 w-28 rounded bg-muted/70" />
        </div>
        <div className="h-6 w-6 rounded-lg bg-muted/70" />
      </div>
      <div className="mt-4 space-y-2.5">
        <div className="h-3 w-full rounded bg-muted/70" />
        <div className="h-3 w-4/5 rounded bg-muted/70" />
        <div className="h-3 w-2/3 rounded bg-muted/70" />
        <div className="h-3 w-1/2 rounded bg-muted/70" />
      </div>
      <div className="mt-6 flex items-center justify-between">
        <div className="h-5 w-24 rounded-full bg-muted/70" />
        <div className="h-8 w-28 rounded bg-muted/70" />
      </div>
    </div>
  );
}
