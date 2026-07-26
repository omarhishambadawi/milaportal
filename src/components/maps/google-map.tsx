import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KSA_CENTER, boundsOf, type LatLng } from "@/lib/geo";
import { MAPS_MAP_ID } from "@/lib/maps/config";
import {
  clusterPoints,
  createClusterElement,
  createPinElement,
  type MapPoint,
} from "@/lib/maps/markers";
import { cn } from "@/lib/utils";

/**
 * The portal's interactive Google map.
 *
 * Generic over the payload each point carries, so it is not a branch component:
 * the Smart Branch Finder, delivery coverage and customer address lookup all
 * render this with their own data and their own click behaviour. Anything
 * branch-specific belongs in the caller, not here.
 *
 * Assumes the SDK is already loaded — `MapSurface` is what decides that. Taking
 * a loaded SDK as a precondition keeps this component free of loading states
 * and means it can be mounted and unmounted freely.
 */

export interface GoogleMapProps<T> {
  points: MapPoint<T>[];
  selectedId?: string | null;
  onSelect?: (point: MapPoint<T> | null) => void;
  /** Rendered in an overlay anchored to the selected point. */
  renderInfo?: (point: MapPoint<T>) => React.ReactNode;
  className?: string;
  /** Zoom applied when a point is selected from outside the map. */
  focusZoom?: number;
  emptyMessage?: string;
}

const DEFAULT_ZOOM = 5;

export function GoogleMap<T>({
  points,
  selectedId,
  onSelect,
  renderInfo,
  className,
  focusZoom = 14,
  emptyMessage,
}: GoogleMapProps<T>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const [ready, setReady] = useState(false);
  // Bumped on every camera idle so clustering recomputes against the new
  // projection. Storing the projection itself in state would re-render on a
  // value React cannot compare.
  const [cameraTick, setCameraTick] = useState(0);

  /* ---------------------------------------------------------------------- */
  /* Map construction                                                        */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;

    const map = new google.maps.Map(host, {
      center: KSA_CENTER,
      zoom: DEFAULT_ZOOM,
      mapId: MAPS_MAP_ID,
      // The default control cluster crowds a half-width panel; zoom and
      // fullscreen are the two that earn their space here.
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      zoomControl: true,
      clickableIcons: false,
      gestureHandling: "greedy",
    });
    mapRef.current = map;

    const idle = map.addListener("idle", () => setCameraTick((tick) => tick + 1));
    // A click on empty map space clears the selection, matching the behaviour
    // of every list/detail pairing in the app.
    const click = map.addListener("click", () => onSelect?.(null));
    setReady(true);

    return () => {
      idle.remove();
      click.remove();
    };
    // Constructed once. `onSelect` is read through a ref-free closure on
    // purpose: rebuilding the map to pick up a new callback would reset the
    // user's camera on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Clustering                                                              */
  /* ---------------------------------------------------------------------- */

  /** Project a coordinate into container pixels at the current camera. */
  const project = useCallback((position: LatLng): { x: number; y: number } | null => {
    const map = mapRef.current;
    const projection = map?.getProjection();
    const bounds = map?.getBounds();
    if (!map || !projection || !bounds) return null;

    const scale = 2 ** (map.getZoom() ?? DEFAULT_ZOOM);
    const world = projection.fromLatLngToPoint(new google.maps.LatLng(position.lat, position.lng));
    const topRight = projection.fromLatLngToPoint(bounds.getNorthEast());
    const bottomLeft = projection.fromLatLngToPoint(bounds.getSouthWest());
    if (!world || !topRight || !bottomLeft) return null;

    return {
      x: (world.x - bottomLeft.x) * scale,
      y: (world.y - topRight.y) * scale,
    };
  }, []);

  const clusters = useMemo(() => {
    if (!ready) return [];
    return clusterPoints(points, project);
    // cameraTick is the dependency that matters: the projection changes with
    // the camera, and the clusters must be recomputed against it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, ready, cameraTick, project]);

  /* ---------------------------------------------------------------------- */
  /* Markers                                                                 */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    for (const marker of markersRef.current) marker.map = null;
    markersRef.current = [];

    for (const cluster of clusters) {
      const isSingle = cluster.members.length === 1;
      const member = cluster.members[0];

      const content = isSingle
        ? createPinElement({
            tone: member.tone,
            selected: member.id === selectedId,
            label: member.id,
          })
        : createClusterElement(cluster.members.length, member.tone);

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: cluster.position,
        content,
        // Selected pin on top, then clusters, so a highlighted branch is never
        // hidden under the bubble it just came out of.
        zIndex: member.id === selectedId ? 1000 : isSingle ? 10 : 5,
      });

      marker.addListener("click", () => {
        if (isSingle) {
          onSelect?.(member.id === selectedId ? null : member);
          return;
        }
        // Zoom toward a cluster rather than jumping to max: two taps that land
        // where you meant beats one that overshoots past the neighbours.
        const box = boundsOf(cluster.members.map((m) => m.position));
        if (!box) return;
        map.fitBounds(
          new google.maps.LatLngBounds(
            { lat: box.south, lng: box.west },
            { lat: box.north, lng: box.east },
          ),
          64,
        );
      });

      markersRef.current.push(marker);
    }

    return () => {
      for (const marker of markersRef.current) marker.map = null;
      markersRef.current = [];
    };
  }, [clusters, selectedId, onSelect, ready]);

  /* ---------------------------------------------------------------------- */
  /* Following an external selection                                         */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !selectedId) return;
    const point = points.find((candidate) => candidate.id === selectedId);
    if (!point) return;

    // Only intervene when the point is off screen or the map is zoomed out.
    // Re-centring on every click would fight an agent stepping through a list
    // of neighbouring branches.
    const bounds = map.getBounds();
    const visible = bounds?.contains(
      new google.maps.LatLng(point.position.lat, point.position.lng),
    );
    if (!visible || (map.getZoom() ?? 0) < focusZoom - 4) {
      map.panTo(point.position);
      if ((map.getZoom() ?? 0) < focusZoom) map.setZoom(focusZoom);
    }
  }, [selectedId, points, ready, focusZoom]);

  /** Frame everything when the visible set changes and nothing is selected. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || selectedId || points.length === 0) return;
    const box = boundsOf(points.map((point) => point.position));
    if (!box) return;
    if (points.length === 1) {
      map.setCenter(points[0].position);
      map.setZoom(focusZoom);
      return;
    }
    map.fitBounds(
      new google.maps.LatLngBounds(
        { lat: box.south, lng: box.west },
        { lat: box.north, lng: box.east },
      ),
      48,
    );
    // Deliberately not reacting to `selectedId`: this is the "no selection"
    // framing pass, and re-running it on deselect would yank the camera back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, ready, focusZoom]);

  const selected = selectedId ? points.find((point) => point.id === selectedId) : null;

  return (
    <div className={cn("relative overflow-hidden rounded-2xl border border-border/60", className)}>
      <div ref={hostRef} className="h-full w-full" />

      {points.length === 0 && emptyMessage && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
            {emptyMessage}
          </p>
        </div>
      )}

      {selected && renderInfo && (
        <div className="pointer-events-auto absolute bottom-3 left-3 right-3 z-10 sm:right-auto sm:w-[19rem]">
          {renderInfo(selected)}
        </div>
      )}
    </div>
  );
}
