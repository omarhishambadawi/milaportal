import { useCallback, useMemo } from "react";
import { Bike, Copy, ExternalLink, Navigation, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MapSurface } from "@/components/maps/map-surface";
import type { MapPoint } from "@/lib/maps/markers";
import { copyText } from "../clipboard";
import type { BranchView } from "../types";
import { BranchMap } from "./branch-map";

/**
 * The Branch Directory's map.
 *
 * A thin adapter, and deliberately so: it turns branches into the generic
 * `MapPoint`s the shared platform understands, supplies the branch-shaped
 * popover, and hands the SVG renderer over as the fallback. All the map
 * behaviour — clustering, camera, marker lifecycle, provider selection — lives
 * in `@/components/maps` where the Smart Branch Finder and the rest will reuse
 * it.
 */

interface Props {
  branches: BranchView[];
  selected: string | null;
  onSelect: (branchNo: string | null) => void;
  className?: string;
}

function BranchInfoCard({ branch, onClose }: { branch: BranchView; onClose: () => void }) {
  return (
    <div className="rounded-xl border border-border/60 bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur-sm animate-in fade-in zoom-in-95 duration-150">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold">{branch.branch_no}</p>
          <p className="truncate text-xs text-muted-foreground" dir="auto">
            {branch.city}
            {branch.cityEnglish && ` · ${branch.cityEnglish}`}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mt-2 text-xs text-foreground/90">
        {branch.working_hours ?? "Hours not recorded"}
      </p>
      {branch.scooter && (
        <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--positive)]">
          <Bike className="h-3 w-3" />
          {branch.scooter_note ?? "Scooter delivery"}
        </p>
      )}
      {branch.address && (
        <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground" dir="auto">
          {branch.address}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {branch.mapsLink && (
          <Button size="sm" className="h-7 text-xs" asChild>
            <a href={branch.mapsLink} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              Google Maps
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => copyText(branch.address ?? "", "Address")}
        >
          <Copy className="h-3 w-3" />
          Copy address
        </Button>
        {branch.navLink && (
          <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
            <a href={branch.navLink} target="_blank" rel="noopener noreferrer">
              <Navigation className="h-3 w-3" />
              Navigate
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

export function BranchMapSurface({ branches, selected, onSelect, className }: Props) {
  const points: MapPoint<BranchView>[] = useMemo(
    () =>
      branches
        .filter((branch) => branch.hasCoords)
        .map((branch) => ({
          id: branch.branch_no,
          position: { lat: branch.latitude as number, lng: branch.longitude as number },
          // Scooter availability is the one attribute agents scan the map for,
          // so it is what the pin colour encodes.
          tone: branch.scooter ? ("positive" as const) : ("primary" as const),
          data: branch,
        })),
    [branches],
  );

  const handleSelect = useCallback(
    (point: MapPoint<BranchView> | null) => onSelect(point?.id ?? null),
    [onSelect],
  );

  const renderInfo = useCallback(
    (point: MapPoint<BranchView>) =>
      point.data ? <BranchInfoCard branch={point.data} onClose={() => onSelect(null)} /> : null,
    [onSelect],
  );

  const renderFallback = useCallback(
    () => (
      <BranchMap
        branches={branches}
        selected={selected}
        onSelect={onSelect}
        className="h-full w-full"
      />
    ),
    [branches, selected, onSelect],
  );

  return (
    <MapSurface
      points={points}
      selectedId={selected}
      onSelect={handleSelect}
      renderInfo={renderInfo}
      renderFallback={renderFallback}
      className={className}
      emptyMessage="No branches with coordinates match the current filters"
    />
  );
}
