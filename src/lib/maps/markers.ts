import type { LatLng } from "@/lib/geo";

/**
 * Marker construction and clustering, shared by every map in the portal.
 *
 * Clustering is hand-rolled rather than pulled from `@googlemaps/markerclusterer`
 * for the same reason the rest of this layer is thin: the algorithm that suits
 * this data is a screen-space grid, which is thirty lines, and the library's
 * value is in its k-means and quadtree strategies that a few thousand points in
 * ten cities do not need. What the library would add is a dependency whose
 * version has to track the SDK's marker API through the AdvancedMarker
 * migration.
 */

/** Any point that can be placed on a map. */
export interface MapPoint<T = unknown> {
  id: string;
  position: LatLng;
  /** Drives the marker colour. */
  tone?: "primary" | "positive" | "attention" | "muted";
  /** Payload handed back to click handlers. */
  data?: T;
}

/**
 * A radius drawn around a point — today, the delivery coverage ring.
 *
 * Part of the shared map contract rather than the Branch Directory's own, because
 * both providers have to honour it: the Google map draws a `google.maps.Circle`
 * and the SVG fallback draws a `<circle>`, and a feature that supplied this to
 * one and not the other would show coverage on some deployments and not others.
 */
export interface MapCoverage {
  center: LatLng;
  radiusMetres: number;
  /** Which theme colour to draw it in. Defaults to `positive`. */
  tone?: "primary" | "positive" | "attention";
}

export interface Cluster<T = unknown> {
  id: string;
  position: LatLng;
  members: MapPoint<T>[];
}

/**
 * Group points that would overlap on screen at the current zoom.
 *
 * Screen-space rather than geographic: 39 Riyadh branches are hundreds of
 * metres apart, which is one unreadable blob at country zoom and comfortably
 * separate at street zoom. Grouping by projected pixels dissolves the clusters
 * naturally as the user zooms in, with no per-zoom thresholds to tune.
 *
 * @param cellPx Grid size in pixels. Roughly the diameter of a marker plus its
 *   label, so anything closer than one marker-width merges.
 */
export function clusterPoints<T>(
  points: readonly MapPoint<T>[],
  project: (position: LatLng) => { x: number; y: number } | null,
  cellPx = 56,
): Cluster<T>[] {
  const cells = new Map<string, Cluster<T>>();

  for (const point of points) {
    const projected = project(point.position);
    // A point the projection cannot place (off the world, or the map is not
    // ready) is dropped rather than piled at the origin.
    if (!projected) continue;

    const key = `${Math.floor(projected.x / cellPx)}:${Math.floor(projected.y / cellPx)}`;
    const cell = cells.get(key);
    if (cell) {
      cell.members.push(point);
      // Running mean, so the bubble sits at the centroid of what it hides
      // rather than on whichever member happened to be first.
      const n = cell.members.length;
      cell.position = {
        lat: cell.position.lat + (point.position.lat - cell.position.lat) / n,
        lng: cell.position.lng + (point.position.lng - cell.position.lng) / n,
      };
    } else {
      cells.set(key, { id: key, position: { ...point.position }, members: [point] });
    }
  }

  return [...cells.values()];
}

const TONE_VARS: Record<NonNullable<MapPoint["tone"]>, string> = {
  primary: "var(--primary)",
  positive: "var(--positive)",
  attention: "var(--attention)",
  muted: "var(--muted-foreground)",
};

/**
 * A single branch pin.
 *
 * Built as a DOM element rather than an SVG data-URI icon so it can use the
 * app's CSS custom properties directly — which is what makes markers follow the
 * light/dark theme without a second palette living in JavaScript.
 */
export function createPinElement(options: {
  tone?: MapPoint["tone"];
  selected?: boolean;
  label?: string;
}): HTMLElement {
  const colour = TONE_VARS[options.tone ?? "primary"];
  const element = document.createElement("div");
  element.className = "milaserv-map-pin";
  element.style.cssText = [
    "position:relative",
    "width:18px",
    "height:18px",
    "border-radius:9999px",
    `background:${colour}`,
    "border:2px solid var(--card)",
    "box-shadow:0 1px 4px rgba(0,0,0,.35)",
    "cursor:pointer",
    "transition:transform 150ms ease",
    options.selected ? "transform:scale(1.35)" : "",
  ].join(";");
  if (options.label) element.title = options.label;
  return element;
}

/** A cluster bubble showing how many pins it stands in for. */
export function createClusterElement(
  count: number,
  tone: MapPoint["tone"] = "primary",
): HTMLElement {
  const colour = TONE_VARS[tone ?? "primary"];
  // Area-proportional growth, capped: a linear radius makes a 40-member cluster
  // swallow the city it sits in.
  const size = Math.min(46, 26 + Math.log2(count) * 4);
  const element = document.createElement("div");
  element.className = "milaserv-map-cluster";
  element.style.cssText = [
    "display:grid",
    "place-items:center",
    `width:${size}px`,
    `height:${size}px`,
    "border-radius:9999px",
    `background:color-mix(in oklab, ${colour} 88%, transparent)`,
    "border:2px solid var(--card)",
    "color:var(--primary-foreground)",
    "font-weight:700",
    `font-size:${Math.max(11, size * 0.36)}px`,
    "box-shadow:0 2px 8px rgba(0,0,0,.3)",
    "cursor:pointer",
  ].join(";");
  element.textContent = String(count);
  return element;
}
