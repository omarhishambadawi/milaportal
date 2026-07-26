import { Ban, Bike, Building2, MapPinned } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BranchStats } from "../search";

/**
 * The four headline numbers.
 *
 * They describe the whole directory rather than the current filter, on purpose:
 * these are the "how big is our network" facts, and having them shrink to 3
 * while someone types a search would make them useless as a reference point.
 * The live count of what a filter matched is shown next to the search box,
 * where it belongs.
 */

interface Tile {
  label: string;
  value: number;
  icon: typeof Building2;
  /** Tailwind colour token pair for the icon chip. */
  tone: string;
}

export function BranchStatsRow({ stats, loading }: { stats: BranchStats; loading?: boolean }) {
  const tiles: Tile[] = [
    {
      label: "Total Branches",
      value: stats.total,
      icon: Building2,
      tone: "bg-primary/12 text-primary",
    },
    {
      label: "Cities",
      value: stats.cities,
      icon: MapPinned,
      tone: "bg-[var(--badge-violet)]/12 text-[var(--badge-violet)]",
    },
    {
      label: "With Scooter",
      value: stats.withScooter,
      icon: Bike,
      tone: "bg-[var(--positive)]/12 text-[var(--positive)]",
    },
    {
      label: "Without Scooter",
      value: stats.withoutScooter,
      icon: Ban,
      tone: "bg-muted text-muted-foreground",
    },
  ];

  return (
    // Four across at every width, including phones. Two-by-two would be prettier
    // in isolation, but it costs a second row of vertical space on exactly the
    // screen where the list needs it most — the whole page is sized to the
    // viewport so the search box can stay pinned.
    <div className="grid grid-cols-4 gap-2 sm:gap-3">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card p-2.5 shadow-sm transition-shadow hover:shadow-md sm:p-4"
        >
          <span
            className={cn(
              "hidden h-9 w-9 shrink-0 place-items-center rounded-lg sm:grid",
              tile.tone,
            )}
            aria-hidden
          >
            <tile.icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:text-[11px]">
              {tile.label}
            </p>
            {loading ? (
              <span className="mt-1 block h-6 w-10 animate-pulse rounded bg-muted" />
            ) : (
              <p className="text-lg font-bold tabular-nums leading-tight text-foreground sm:text-2xl">
                {tile.value.toLocaleString()}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
