import { CircleSlash, KeyRound, UserCheck, Users as UsersIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type { UserStats, UserStatusFilter } from "../types";

/**
 * The four headline counts, each also a filter shortcut.
 *
 * Buttons rather than static tiles: "4 awaiting password" is only useful if the
 * next click shows you which four. `aria-pressed` carries the selected state, so
 * the active facet is announced rather than only coloured.
 */
export function UsersStatCards({
  stats,
  status,
  onSelect,
}: {
  stats: UserStats;
  status: UserStatusFilter;
  onSelect: (status: UserStatusFilter) => void;
}) {
  const cards = [
    { key: "all" as const, label: "Total", value: stats.total, icon: UsersIcon, tone: "text-primary" },
    { key: "active" as const, label: "Active", value: stats.active, icon: UserCheck, tone: "text-[var(--positive)]" },
    { key: "inactive" as const, label: "Inactive", value: stats.inactive, icon: CircleSlash, tone: "text-muted-foreground" },
    { key: "pending" as const, label: "Awaiting password", value: stats.pending, icon: KeyRound, tone: "text-[var(--badge-amber)]" },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      {cards.map(({ key, label, value, icon: Icon, tone }) => {
        const selected = status === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            aria-pressed={selected}
            className={cn(
              "group rounded-lg border bg-card p-3 text-left transition-colors duration-150",
              "hover:border-primary/40 hover:bg-accent/40",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected && "border-primary/50 bg-primary/5",
            )}
          >
            <div className="flex items-center gap-2">
              <Icon className={cn("h-4 w-4 shrink-0", tone)} aria-hidden />
              <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
            </div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
          </button>
        );
      })}
    </div>
  );
}
