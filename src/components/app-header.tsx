import { useEffect, useState, type ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { Menu, ChevronDown, LogOut, UserCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { UserAvatar } from "@/components/user-avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  title: string;
  icon?: ComponentType<{ className?: string }>;
  onOpenMobile: () => void;
  name: string;
  role?: string | null;
  avatarUrl?: string | null;
  onSignOut: () => void;
};

/**
 * Application top bar. Presentation only — all actions (sign out,
 * navigation) are delegated to props/existing routes; no business logic lives here.
 * The desktop sidebar toggle lives inside the sidebar itself; the mobile
 * menu button below opens the mobile drawer (the sidebar isn't rendered on mobile).
 */
export function AppHeader({
  title,
  icon: Icon,
  onOpenMobile,
  name,
  role,
  avatarUrl,
  onSignOut,
}: AppHeaderProps) {
  // Scroll-aware chrome: the header gains a shadow + firmer border once the page
  // scrolls, so it reads as a floating layer over content (Linear/Vercel pattern).
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const roleLabel = role?.replace(/_/g, " ") ?? "—";

  return (
    <header
      className={cn(
        "sticky top-0 z-30 h-16 flex items-center gap-2 px-3 sm:px-5",
        "border-b bg-card/70 backdrop-blur-xl supports-[backdrop-filter]:bg-card/55",
        "transition-[box-shadow,background-color,border-color] duration-300",
        scrolled
          ? "border-border shadow-[0_1px_0_0_rgba(0,0,0,0.02),0_8px_24px_-16px_rgba(0,0,0,0.25)]"
          : "border-border/50 shadow-none",
      )}
    >
      {/* ── Left: mobile menu (drawer opener) + page identity ─────────────── */}
      <div className="flex items-center gap-1.5 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden h-9 w-9 rounded-lg text-foreground/70 transition-colors duration-200 hover:text-foreground active:scale-95"
          onClick={onOpenMobile}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>

        <div className="hidden sm:block mx-1 h-6 w-px bg-border/70" aria-hidden />

        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && (
            <span className="hidden sm:grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
              <Icon className="h-[18px] w-[18px]" />
            </span>
          )}
          <div className="min-w-0 leading-none">
            <div className="hidden sm:block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
              MilaServ
            </div>
            <div className="mt-0.5 text-[15px] sm:text-sm font-semibold tracking-tight text-foreground truncate">
              {title}
            </div>
          </div>
        </div>
      </div>

      {/* ── Right: actions + profile ────────────────────────────────────── */}
      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
        <div className="flex items-center gap-0.5 rounded-xl bg-muted/40 p-0.5 ring-1 ring-inset ring-border/50">
          <ThemeToggle className="h-9 w-9 rounded-lg hover:bg-background/70" />
          <NotificationBell />
        </div>

        <div className="mx-0.5 hidden sm:block h-6 w-px bg-border/70" aria-hidden />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "group flex items-center gap-2 rounded-xl py-1 pl-1 pr-1.5 sm:pr-2.5",
                "text-left transition-colors duration-200 hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                "data-[state=open]:bg-accent",
              )}
              aria-label="Account menu"
            >
              <UserAvatar
                name={name}
                url={avatarUrl}
                size="sm"
                className="ring-2 ring-background"
              />
              <div className="hidden lg:block min-w-0 leading-tight">
                <div className="text-xs font-semibold truncate max-w-[9rem] text-foreground">
                  {name}
                </div>
                <div className="text-[10px] text-muted-foreground capitalize truncate max-w-[9rem]">
                  {roleLabel}
                </div>
              </div>
              <ChevronDown className="hidden sm:block h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="w-60 rounded-xl p-1.5">
            <DropdownMenuLabel className="p-0">
              <Link
                to="/profile"
                className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-accent"
              >
                <UserAvatar name={name} url={avatarUrl} size="md" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate text-foreground">{name}</div>
                  <div className="text-[11px] font-normal text-muted-foreground capitalize truncate">
                    {roleLabel}
                  </div>
                </div>
              </Link>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="rounded-lg py-2 cursor-pointer">
              <Link to="/profile">
                <UserCircle2 className="mr-2 h-4 w-4" />
                <span>Profile & settings</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onSignOut}
              className="rounded-lg py-2 cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Sign out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
