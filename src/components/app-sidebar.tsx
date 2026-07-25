import { memo, useMemo, type ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, X } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";


export type NavItemData = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

type SidebarProps = {
  nav: NavItemData[];
  activePath: string;
  expanded: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  name: string;
  role?: string | null;
  avatarUrl?: string | null;
  onSignOut: () => void;
};

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
    match: (t) => t === "/orders" || t === "/orders/new" || t === "/complaints" || t === "/call-center",
  },
  { id: "admin", label: "Administration", match: (t) => t.startsWith("/admin") },
];

function groupNav(nav: NavItemData[]) {
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

/**
 * Memoized so the nav does not re-render on unrelated parent updates (route
 * changes that leave `activePath` alone, avatar loads, header state). It still
 * re-renders on collapse, which is correct — `collapsed` genuinely changes what
 * it renders.
 */
const NavItem = memo(function NavItem({
  item,
  active,
  collapsed,
}: {
  item: NavItemData;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center rounded-xl outline-none transition-colors duration-200 ease-out",
        "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        collapsed ? "justify-center p-1.5" : "gap-3 px-2 py-1.5",
        active ? "bg-primary/10" : "hover:bg-accent/70",
      )}
    >
      {/* Active rail — animates in from the left edge */}
      {active && !collapsed && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary animate-in fade-in slide-in-from-left-1 duration-300"
        />
      )}
      {/* Icon container — the core of the visual language */}
      <span
        className={cn(
          // Narrowed from `transition-all`: this element only ever changes
          // colours, its shadow, and `scale` on press. Listing them keeps the
          // press feedback on the compositor without animating the layout
          // properties that shift when the sidebar collapses.
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-[color,background-color,box-shadow,transform] duration-200 ease-out",
          active
            ? "bg-primary text-primary-foreground shadow-sm shadow-primary/30"
            : "text-foreground/70 group-hover:bg-background group-hover:text-foreground group-active:scale-90",
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      {!collapsed && (
        <span
          className={cn(
            "truncate text-sm tracking-tight transition-colors duration-200",
            active
              ? "font-semibold text-foreground"
              : "font-medium text-foreground/70 group-hover:text-foreground",
          )}
        >
          {item.label}
        </span>
      )}
    </Link>
  );
});

/** Shared inner shell used by both the desktop rail and the mobile drawer. */
function SidebarInner({
  nav,
  activePath,
  collapsed,
  onToggle,
  onMobileClose,
}: {
  nav: NavItemData[];
  activePath: string;
  collapsed: boolean;
  onToggle?: () => void;
  onMobileClose?: () => void;
}) {
  // Rebuilt on every render before this — including every frame-adjacent render
  // during a collapse — even though it depends only on `nav`.
  const groups = useMemo(() => groupNav(nav), [nav]);

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div
        className={cn(
          "flex h-16 shrink-0 items-center border-b border-border/60",
          collapsed ? "justify-center px-2" : "px-4",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandLogo />
          {!collapsed && (
            <div className="min-w-0">
              <div className="truncate text-sm font-bold leading-tight tracking-tight text-foreground">
                MilaServ
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
                Portal
              </div>
            </div>
          )}
        </div>
        {onMobileClose && (
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav
        className={cn(
          "flex-1 overflow-y-auto overflow-x-hidden py-3",
          "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
          "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent",
          "hover:[&::-webkit-scrollbar-thumb]:bg-border/70",
          collapsed ? "px-2.5" : "px-3",
        )}
      >
        {groups.map((g, gi) => (
          <div
            key={g.id}
            className={cn(
              gi > 0 && (collapsed ? "mt-2 border-t border-border/50 pt-2" : "mt-5"),
            )}
          >
            {!collapsed && (
              <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                {g.label}
              </div>
            )}
            <div className="space-y-0.5">
              {g.items.map((it) => (
                <NavItem
                  key={it.to}
                  item={it}
                  active={activePath === it.to}
                  collapsed={collapsed}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer — sidebar toggle only. Profile & sign out live in the header. */}
      {onToggle && (
        <div className="mt-auto border-t border-border/60 p-2">
          <button
            type="button"
            onClick={onToggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "flex h-9 w-full items-center rounded-lg text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground",
              collapsed ? "justify-center" : "gap-2 px-2.5",
            )}
          >
            <ChevronLeft
              className={cn("h-4 w-4 transition-transform duration-300 ease-out", collapsed && "rotate-180")}
            />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      )}
    </div>
  );
}


export function AppSidebar({
  nav,
  activePath,
  expanded,
  onToggle,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  return (
    <>
      {/* Desktop rail */}
      <aside
        className={cn(
          "z-20 hidden shrink-0 flex-col md:flex",
          "sticky top-0 h-screen bg-card border-r border-border/70",
          // `will-change-[width]` was here and has been removed. will-change is a
          // hint to promote an element to its own compositor layer, which only
          // helps properties the compositor can animate by itself — transform and
          // opacity. `width` is a layout property: the browser still runs full
          // layout for this element and the main content beside it on every
          // frame, so the hint bought nothing while permanently holding an extra
          // layer (and its memory) for an animation that runs for 300ms.
          "transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
          expanded ? "w-64" : "w-[76px]",
        )}
      >
        <SidebarInner
          nav={nav}
          activePath={activePath}
          collapsed={!expanded}
          onToggle={onToggle}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onMobileClose}
          />
          <aside className="absolute inset-y-0 left-0 flex w-[min(17rem,84vw)] flex-col border-r border-border bg-card shadow-2xl animate-in slide-in-from-left duration-300 ease-out">
            <SidebarInner
              nav={nav}
              activePath={activePath}
              collapsed={false}
              onMobileClose={onMobileClose}
            />
          </aside>
        </div>
      )}
    </>
  );
}

