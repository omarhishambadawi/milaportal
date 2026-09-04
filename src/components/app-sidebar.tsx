import { memo, useEffect, useMemo, useRef, type ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, X } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { NavFlyout } from "@/components/nav-flyout";
import { cn } from "@/lib/utils";

export type NavItemData = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * What the rail shows under the icon, when the full label does not fit.
   *
   * One word of about ten characters is what a 92px rail holds at 11px; only
   * "Administration" exceeds it, at 75px against 68px of room. The full `label`
   * is still what the header names the page and what the drawer and the `title`
   * attribute say, so nothing is lost — the rail is simply not the place to
   * spell it out.
   */
  shortLabel?: string;
  /**
   * Sub-items shown in a right-hand flyout. The parent stays a real link, so
   * the menu is never the only way to reach it and keyboard users can tab
   * straight through.
   */
  children?: NavItemData[];
  /** Renders a divider above this child inside the flyout. */
  separatorBefore?: boolean;
  /**
   * A small heading above this child inside the flyout.
   *
   * The CRM needs it: Cash is a *group* of two destinations and Wasfaty is one
   * destination, and a flat list of three cannot say that. A nested flyout
   * could, but a submenu that opens out of a submenu on a 92px rail is a
   * pointer-tracking problem nobody enjoys solving, and this reads the same.
   */
  groupLabel?: string;
  /**
   * Query parameters this entry carries.
   *
   * For children that are one route asked a different question — Cash and
   * Retention are both `/telesales`, narrowed to a pipeline. Present in the
   * link and in the active-state comparison, so two children sharing a path do
   * not both light up.
   */
  search?: Record<string, string>;
};

/**
 * The identity of a nav entry, path plus whatever query it pins.
 *
 * `to` alone stopped being unique the moment two children shared a route, and
 * every active-state comparison in here is an equality test against one string.
 * Keys are sorted so two equivalent entries cannot produce two different ids.
 */
export function navKey(item: Pick<NavItemData, "to" | "search">): string {
  const entries = Object.entries(item.search ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return item.to;
  return `${item.to}?${entries.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

type SidebarProps = {
  nav: NavItemData[];
  activePath: string;
  mobileOpen: boolean;
  onMobileClose: () => void;
};

/**
 * The navigation rail, and the mobile drawer that stands in for it.
 *
 * ---------------------------------------------------------------------------
 * There is no expanded state any more
 * ---------------------------------------------------------------------------
 * The rail used to be 76px that animated to 16rem and back, with the preference
 * in `localStorage`. All of it is gone: the width transition, the toggle button
 * in the footer, `data-state`/`group/rail` and the dozen
 * `group-data-[state=collapsed]/rail:` variants that drove labels, headings and
 * the divider through it, and the `expanded` state and its persistence in the
 * `_app` route.
 *
 * A width animation is layout-bound by nature — the browser re-lays out the
 * rail *and* the whole main column on every frame — so it was never going to be
 * as smooth as the rest of the app, and no amount of tuning the clock changes
 * that. Removing the state removes the animation, and removing the animation is
 * what makes the sidebar calm.
 *
 * What is left is a rail that was designed as one rather than as a squeezed
 * sidebar: the label lives under the icon instead of being clipped to zero
 * width beside it, so every destination is readable without a hover, and the
 * `title` tooltips that only existed to compensate for hidden labels are gone
 * with them.
 *
 * ---------------------------------------------------------------------------
 * Two presentations, stated rather than implied
 * ---------------------------------------------------------------------------
 * The rail is vertical (icon over label, centred); the mobile drawer is a
 * full-width overlay where horizontal rows are the right shape. That used to be
 * one tree plus CSS variants keyed off an ancestor's `data-state`; it is now a
 * `variant` prop, which is the same rendering with the branch written down.
 */

/**
 * One easing curve and one duration for everything in here.
 *
 * The same `cubic-bezier(0.4, 0, 0.2, 1)` the Dashboard's entrances use, so a
 * hover in the rail and a chart arriving on the page are visibly the same
 * product. 200ms is quick enough to feel like a response to the pointer rather
 * than an animation of it.
 *
 * Only colours ride this clock. Nothing in the rail moves, scales or lifts on
 * hover: persistent chrome that shifts under a pointer already reaching for it
 * is the single most irritating thing navigation can do.
 */
const NAV_MOTION =
  "transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none";

/** Focus ring, identical on every interactive element in the sidebar. */
const NAV_FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card";

/**
 * Presentational grouping of the (already permission-filtered) nav items into
 * labelled sections. Purely visual — routing/permissions are untouched; any
 * item not matched by a section falls through into "More".
 */
const SECTIONS: { id: string; label: string; match: (to: string) => boolean }[] = [
  { id: "overview", label: "Overview", match: (t) => t === "/dashboard" },
  {
    id: "workspace",
    label: "Workspace",
    match: (t) => t === "/orders" || t === "/orders/new" || t === "/complaints" || t === "/calls",
  },
  { id: "admin", label: "Administration", match: (t) => t.startsWith("/admin") },
];

/**
 * Is this item, or anything under it, the current page?
 *
 * Exact matching alone left a parent looking inactive while the user was on one
 * of its children, which is the one moment it most needs to look active.
 */
export function isBranchActive(item: NavItemData, activePath: string): boolean {
  if (activePath === navKey(item)) return true;
  return (item.children ?? []).some((c) => activePath === navKey(c));
}

/**
 * Which nav entry the current URL belongs to.
 *
 * Children are candidates alongside top-level items, and the longest match
 * wins, so /orders/123 resolves to "/orders" while /calls/telesales resolves to
 * itself.
 *
 * Considering only top-level items collapsed every child route onto its parent,
 * and that single value feeds three separate things: the child link's own
 * highlight (which could therefore never turn on), `isBranchActive` (whose
 * child arm was consequently unreachable in production, while the parent still
 * lit up via its exact match — so the tests below passed against logic the app
 * never ran), and the flyout's close-on-navigate effect (which never fired when
 * moving between two siblings, because the value did not change).
 */
export function resolveActivePath(
  nav: NavItemData[],
  pathname: string,
  search: Record<string, unknown> = {},
): string {
  const entries = nav.flatMap((m) => [m, ...(m.children ?? [])]);
  const matches = entries.filter((m) => {
    if (pathname !== m.to && !pathname.startsWith(m.to + "/")) return false;
    /*
     * An entry that pins a query only matches when the address bar agrees.
     *
     * Without this, `/telesales` would light up Cash *and* Retention at once,
     * and `/telesales` with no query would light up whichever came first — the
     * entry would claim a filter the user has not applied.
     */
    return Object.entries(m.search ?? {}).every(([k, v]) => String(search[k] ?? "") === v);
  });
  // The more specific entry wins: a pinned query beats the bare route it
  // narrows, and only then does the longer path win.
  const best = matches.sort((a, b) => {
    const pinned = Object.keys(b.search ?? {}).length - Object.keys(a.search ?? {}).length;
    return pinned !== 0 ? pinned : b.to.length - a.to.length;
  })[0];
  return best ? navKey(best) : "";
}

export function groupNav(nav: NavItemData[]) {
  const groups = SECTIONS.map((s) => ({
    id: s.id,
    label: s.label,
    items: nav.filter((n) => s.match(n.to)),
  })).filter((g) => g.items.length > 0);
  const claimed = new Set(groups.flatMap((g) => g.items.map((i) => i.to)));
  const rest = nav.filter((n) => !claimed.has(n.to));
  if (rest.length) groups.push({ id: "more", label: "More", items: rest });
  return groups;
}

type Variant = "rail" | "drawer";

/**
 * One navigation entry, in whichever of the two shapes its container needs.
 *
 * The active state is three things and deliberately not more: a tinted panel,
 * the icon in the brand colour, and the label a weight heavier. The version
 * before this had those plus a filled primary chip behind the icon plus a rail
 * sliding in from the left edge — five treatments competing to say one thing,
 * and the left-edge rail is meaningless against a centred item anyway.
 */
const NavItem = memo(function NavItem({
  item,
  active,
  activePath,
  variant,
  onNavigate,
}: {
  item: NavItemData;
  active: boolean;
  activePath?: string;
  variant: Variant;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const children = item.children ?? [];
  const rail = variant === "rail";
  // The rail shortens exactly one label, so the tooltip is worth carrying for
  // exactly that one. Anywhere the label is shown in full a `title` would
  // repeat text already on screen, which is noise on a pointer pause.
  const shown = rail ? (item.shortLabel ?? item.label) : item.label;

  const link = (
    <Link
      to={item.to}
      search={item.search}
      title={shown === item.label ? undefined : item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex rounded-lg",
        NAV_MOTION,
        NAV_FOCUS,
        rail
          ? "flex-col items-center gap-1.5 px-1 py-2.5"
          : "items-center gap-3 overflow-hidden px-2.5 py-2",
        active ? "bg-primary/10 dark:bg-primary/15" : "hover:bg-accent/60 dark:hover:bg-accent/40",
      )}
    >
      <Icon
        className={cn(
          "shrink-0",
          NAV_MOTION,
          rail ? "h-5 w-5" : "h-[18px] w-[18px]",
          active ? "text-primary" : "text-foreground/70 group-hover:text-foreground",
        )}
      />
      <span
        className={cn(
          "truncate",
          NAV_MOTION,
          rail ? "w-full text-center text-[11px] leading-tight" : "min-w-0 flex-1 text-sm",
          active
            ? "font-semibold text-foreground"
            : "font-medium text-foreground/70 group-hover:text-foreground",
        )}
      >
        {shown}
      </span>
      {children.length > 0 && (
        /*
         * The submenu affordance. Hover and focus already open the panel, so
         * this exists for the deliberate click and for touch.
         *
         * Centred on the item's right edge rather than pinned to its top
         * corner. As a corner mark it sat level with the icon's top edge and
         * read as misaligned against every other control in the rail — and with
         * two of these now (Calls and Admin) the inconsistency was doubled.
         * `top-1/2 -translate-y-1/2` centres it against the whole item, which
         * is where the expanded variant's `ml-auto` already puts it.
         */
        <span
          data-flyout-toggle
          role="button"
          tabIndex={-1}
          aria-label={`Toggle ${item.label} menu`}
          className={cn(
            "grid shrink-0 place-items-center rounded",
            rail ? "absolute right-0.5 top-1/2 h-4 w-4 -translate-y-1/2" : "ml-auto h-5 w-5",
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn("text-muted-foreground/70", rail ? "h-3 w-3" : "h-3.5 w-3.5")}
          />
        </span>
      )}
    </Link>
  );

  if (children.length === 0) return link;

  // The panel has to escape the sidebar's `overflow-x-hidden`, so it lives in a
  // portal — see NavFlyout.
  return (
    <NavFlyout
      item={item}
      activePath={activePath ?? ""}
      variant={variant}
      trigger={link}
      onNavigate={onNavigate}
    />
  );
});

/**
 * The rail's brand block and the drawer's, which differ only in whether the
 * wordmark is there to be read.
 */
function Brand({ variant, onClose }: { variant: Variant; onClose?: () => void }) {
  return (
    <div
      className={cn(
        "flex h-16 shrink-0 items-center border-b border-border/60",
        variant === "rail" ? "justify-center px-2" : "px-3.5",
      )}
    >
      <BrandLogo />
      {variant === "drawer" && (
        <div className="min-w-0 pl-2.5">
          <div className="truncate text-sm font-bold leading-tight tracking-tight text-foreground">
            MilaServ
          </div>
          <div className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
            Portal
          </div>
        </div>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          data-sidebar-close
          className={cn(
            "ml-auto grid h-9 w-9 place-items-center rounded-lg text-muted-foreground",
            NAV_MOTION,
            NAV_FOCUS,
            "hover:bg-accent hover:text-foreground",
          )}
        >
          <X className="h-[18px] w-[18px]" />
        </button>
      )}
    </div>
  );
}

/** The shared inner shell, in one of its two shapes. */
const SidebarInner = memo(function SidebarInner({
  nav,
  activePath,
  variant,
  onMobileClose,
}: {
  nav: NavItemData[];
  activePath: string;
  variant: Variant;
  onMobileClose?: () => void;
}) {
  const groups = useMemo(() => groupNav(nav), [nav]);
  const rail = variant === "rail";

  return (
    <div className="flex h-full flex-col">
      <Brand variant={variant} onClose={onMobileClose} />

      <nav
        aria-label="Primary"
        className={cn(
          "flex-1 overflow-y-auto overflow-x-hidden",
          rail ? "px-2 py-3" : "px-2.5 py-4",
          "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
          "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent",
          "hover:[&::-webkit-scrollbar-thumb]:bg-border/70",
        )}
      >
        {groups.map((g, gi) => (
          <div
            key={g.id}
            /* A section heading needs a line of prose the rail does not have —
               "Administration" as a heading is wider than the rail is. So the
               rail states the same grouping as a hairline and the drawer keeps
               the words. */
            className={cn(gi > 0 && (rail ? "mt-3 border-t border-border/60 pt-3" : "mt-5"))}
          >
            {!rail && (
              <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                {g.label}
              </div>
            )}
            <div className={rail ? "space-y-0.5" : "space-y-1"}>
              {g.items.map((it) => (
                <NavItem
                  key={it.to}
                  item={it}
                  active={isBranchActive(it, activePath)}
                  activePath={activePath}
                  variant={variant}
                  onNavigate={onMobileClose}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );
});

export function AppSidebar({ nav, activePath, mobileOpen, onMobileClose }: SidebarProps) {
  const drawerRef = useRef<HTMLElement | null>(null);

  /**
   * Escape closes the drawer, and opening it puts focus inside.
   *
   * Neither existed before: the overlay could only be dismissed by pointing at
   * the backdrop or the X, and opening it left focus behind on the header's
   * menu button, so a keyboard user tabbed through the page *underneath* the
   * overlay. Focus goes to the close button because it is the drawer's first
   * control and its escape hatch.
   */
  useEffect(() => {
    if (!mobileOpen) return;
    drawerRef.current?.querySelector<HTMLElement>("[data-sidebar-close]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onMobileClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onMobileClose]);

  return (
    <>
      {/* Desktop rail. One fixed width, no transition on it, nothing to toggle.
          `print:hidden`: the rail is app chrome. On paper it took a sixth of
          every page and narrowed the report column to match, which is what
          cropped the Monthly Report's charts and its widest table. */}
      <aside
        className={cn(
          "z-20 hidden w-[92px] shrink-0 flex-col md:flex print:hidden",
          "sticky top-0 h-screen border-r border-border/70 bg-card",
        )}
      >
        <SidebarInner nav={nav} activePath={activePath} variant="rail" />
      </aside>

      {/* Mobile drawer. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 motion-reduce:animate-none"
            onClick={onMobileClose}
          />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className={cn(
              "absolute inset-y-0 left-0 flex w-[min(17rem,84vw)] flex-col border-r border-border bg-card shadow-2xl",
              "animate-in slide-in-from-left duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:animate-none",
            )}
          >
            <SidebarInner
              nav={nav}
              activePath={activePath}
              variant="drawer"
              onMobileClose={onMobileClose}
            />
          </aside>
        </div>
      )}
    </>
  );
}
