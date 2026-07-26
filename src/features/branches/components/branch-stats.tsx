import { Bike, Building2, MapPinned, RefreshCw } from "lucide-react";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import type { ImportHistoryEntry } from "../types";
import type { BranchStats } from "../search";

/**
 * The directory's headline facts, on one line.
 *
 * This replaced a row of four stat tiles. The numbers themselves are worth
 * keeping — "how big is the network" is a reasonable thing to see — but they were
 * never the reason anyone opened this page, and as tiles they cost about 80px of
 * a viewport-height layout whose scarcest resource is rows of cards. As a line of
 * small text they cost 20px and read the same.
 *
 * The freshness stamp shares the line on purpose: an age is only meaningful next
 * to the thing it describes.
 */

function stamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: BUSINESS_TIMEZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

interface Props {
  stats: BranchStats;
  loading?: boolean;
  /** Set while a search or filter is narrowing the list. */
  resultCount: number;
  filtered: boolean;
  /** Newest `updated_at` across the directory. */
  lastUpdated: string | null;
  /** The last import, when the viewer is allowed to know about it. */
  lastImport: ImportHistoryEntry | null;
}

export function BranchDirectoryMeta({
  stats,
  loading,
  resultCount,
  filtered,
  lastUpdated,
  lastImport,
}: Props) {
  if (loading) {
    return <span className="block h-4 w-64 animate-pulse rounded bg-muted" />;
  }

  const source = lastImport?.file_name ?? null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span
        className={cn(
          "inline-flex items-center gap-1.5",
          filtered && "font-medium text-foreground",
        )}
      >
        <Building2 className="h-3.5 w-3.5 opacity-70" aria-hidden />
        {filtered ? (
          <>
            <span className="tabular-nums">{resultCount.toLocaleString()}</span> of{" "}
            <span className="tabular-nums">{stats.total.toLocaleString()}</span> branches
          </>
        ) : (
          <>
            <span className="tabular-nums">{stats.total.toLocaleString()}</span> branches
          </>
        )}
      </span>

      <span aria-hidden className="opacity-40">
        ·
      </span>
      <span className="inline-flex items-center gap-1.5">
        <MapPinned className="h-3.5 w-3.5 opacity-70" aria-hidden />
        <span className="tabular-nums">{stats.cities.toLocaleString()}</span> cities
      </span>

      <span aria-hidden className="opacity-40">
        ·
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Bike className="h-3.5 w-3.5 opacity-70" aria-hidden />
        <span className="tabular-nums">{stats.withScooter.toLocaleString()}</span> with scooter
      </span>

      {lastUpdated && (
        <>
          <span aria-hidden className="hidden opacity-40 sm:inline">
            ·
          </span>
          <span
            className="hidden items-center gap-1.5 sm:inline-flex"
            title={
              source
                ? `Last import: ${source}${
                    lastImport?.importer_name ? ` by ${lastImport.importer_name}` : ""
                  }`
                : "The most recent change to any branch record, made by an import."
            }
          >
            <RefreshCw className="h-3.5 w-3.5 opacity-70" aria-hidden />
            Updated {stamp(lastUpdated)}
            {source && <span className="hidden truncate lg:inline">· {source}</span>}
          </span>
        </>
      )}
    </div>
  );
}
