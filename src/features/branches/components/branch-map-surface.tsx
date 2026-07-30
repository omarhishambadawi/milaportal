import { useCallback, useMemo } from "react";
import { Bike, Copy, ExternalLink, Navigation, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MapSurface } from "@/components/maps/map-surface";
import { haversineMetres, type LatLng } from "@/lib/geo";
import type { MapCoverage, MapPoint } from "@/lib/maps/markers";
import { copyText } from "../clipboard";
import { COVERAGE_RADIUS_METRES, isWithinCoverage } from "../delivery-eta";
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
  /**
   * The customer's location, when the locator has resolved one.
   *
   * Its presence switches the map into "delivery" mode: a coverage ring is drawn
   * around it and the pins re-encode to say which branches fall inside. Absent —
   * the ordinary directory view — nothing changes and the pins keep meaning
   * scooter availability.
   */
  coverageCenter?: LatLng | null;
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

export function BranchMapSurface({
  branches,
  selected,
  onSelect,
  coverageCenter,
  className,
}: Props) {
  /**
   * Inside coverage, per branch.
   *
   * Measured with the same Haversine the locator's distances come from, so a pin
   * can never be green while the row for the same branch warns that it is over
   * 10 km. Null when there is no origin, which is how both renderers know to fall
   * back to the scooter encoding.
   */
  const insideCoverage = useMemo(() => {
    if (!coverageCenter) return null;
    const map = new Map<string, boolean>();
    for (const branch of branches) {
      if (!branch.hasCoords) continue;
      const metres = haversineMetres(coverageCenter, {
        lat: branch.latitude as number,
        lng: branch.longitude as number,
      });
      map.set(branch.branch_no, isWithinCoverage(metres));
    }
    return map;
  }, [branches, coverageCenter]);

  const points: MapPoint<BranchView>[] = useMemo(
    () =>
      branches
        .filter((branch) => branch.hasCoords)
        .map((branch) => ({
          id: branch.branch_no,
          position: { lat: branch.latitude as number, lng: branch.longitude as number },
          // In delivery mode the pin answers "can this branch serve the order":
          // green inside the ring, amber outside. Out-of-coverage branches are
          // recoloured, never removed — an agent needs to see that the nearest
          // option is 14 km away, not be shown an empty map.
          //
          // Otherwise scooter availability, which is the one attribute agents
          // scan the ordinary directory map for.
          tone: insideCoverage
            ? insideCoverage.get(branch.branch_no)
              ? ("positive" as const)
              : ("attention" as const)
            : branch.scooter
              ? ("positive" as const)
              : ("primary" as const),
          data: branch,
        })),
    [branches, insideCoverage],
  );

  const coverage: MapCoverage | null = useMemo(
    () =>
      coverageCenter
        ? { center: coverageCenter, radiusMetres: COVERAGE_RADIUS_METRES, tone: "positive" }
        : null,
    [coverageCenter],
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

  const toneFor = useCallback(
    (branch: BranchView) => {
      if (!insideCoverage) return null;
      return insideCoverage.get(branch.branch_no) ? ("positive" as const) : ("attention" as const);
    },
    [insideCoverage],
  );

  const renderFallback = useCallback(
    () => (
      <BranchMap
        branches={branches}
        selected={selected}
        onSelect={onSelect}
        coverage={coverage}
        toneFor={toneFor}
        className="h-full w-full"
      />
    ),
    [branches, selected, onSelect, coverage, toneFor],
  );

  return (
    <MapSurface
      points={points}
      selectedId={selected}
      onSelect={handleSelect}
      renderInfo={renderInfo}
      renderFallback={renderFallback}
      coverage={coverage}
      className={className}
      emptyMessage="No branches with coordinates match the current filters"
    />
  );
}
