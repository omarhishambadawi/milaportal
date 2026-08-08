import { useEffect, useMemo, useRef, useState } from "react";
import { KSA_CENTER } from "@/lib/geo";
import { useTheme } from "@/lib/theme";
import type { BranchView } from "../types";

/**
 * The Branch Directory map.
 *
 * Google Maps JavaScript SDK, loaded with the browser key published by the
 * managed Google Maps connection (`VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`).
 * No key is hardcoded, and nothing here talks to the server: the directory
 * already carries every branch's coordinates, so the map is a second view of the
 * rows the filters produced rather than a second data source.
 *
 * Markers follow `branches` — the filtered result set — so narrowing the search
 * narrows the map. `selected` focuses one branch and opens its info window,
 * which is the same selection the cards and the locator share.
 */

/** Only ever loaded once per page, however many maps mount. */
let sdkPromise: Promise<typeof google.maps> | null = null;

function loadMapsSdk(key: string): Promise<typeof google.maps> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  sdkPromise ??= new Promise((resolve, reject) => {
    // `loading=async` means google.maps is not ready at script onload; the
    // callback is the only reliable signal. See the Maps loading guide.
    const callbackName = "__milaservMapsReady";
    (window as unknown as Record<string, unknown>)[callbackName] = () =>
      resolve(window.google.maps);
    const script = document.createElement("script");
    const tracking = import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID;
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
      `&loading=async&callback=${callbackName}&region=SA` +
      (tracking ? `&channel=${encodeURIComponent(tracking)}` : "");
    script.async = true;
    script.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/** Muted night palette, close to the portal's navy-slate dark surfaces. */
const DARK_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#1b2433" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#93a4bd" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#151c28" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#273449" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8fa2ba" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#111823" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#33415a" }] },
];

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

/** Info window body: the same facts the card leads with. */
function infoHtml(branch: BranchView): string {
  const rows: string[] = [];
  const city = branch.cityEnglish ? `${branch.city} · ${branch.cityEnglish}` : branch.city;
  rows.push(`<div style="color:#475569">${escapeHtml(city)}</div>`);
  if (branch.addressLine) {
    rows.push(`<div style="color:#64748b">${escapeHtml(branch.addressLine)}</div>`);
  }
  if (branch.phoneDisplay) {
    rows.push(
      `<div><a href="tel:${escapeHtml(branch.phoneE164 ?? branch.phoneDisplay)}" style="color:#0f766e">${escapeHtml(branch.phoneDisplay)}</a></div>`,
    );
  }
  if (branch.area_manager) {
    rows.push(`<div style="color:#64748b">${escapeHtml(branch.area_manager)}</div>`);
  }
  if (branch.mapsLink) {
    rows.push(
      `<div style="margin-top:4px"><a href="${escapeHtml(branch.mapsLink)}" target="_blank" rel="noreferrer" style="color:#0f766e">Open in Google Maps</a></div>`,
    );
  }
  return (
    `<div style="font:13px/1.5 system-ui,sans-serif;max-width:230px">` +
    `<div style="font-weight:600;color:#0f172a;margin-bottom:2px">${escapeHtml(branch.branch_no)}</div>` +
    rows.join("") +
    `</div>`
  );
}

interface BranchMapProps {
  /** The filtered rows; markers mirror these exactly. */
  branches: BranchView[];
  /** Branch code to focus, or null. */
  selected: string | null;
  onSelect: (branchNo: string) => void;
}

export function BranchMap({ branches, selected, onSelect }: BranchMapProps) {
  const { theme } = useTheme();
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<google.maps.Map | null>(null);
  const markers = useRef<Map<string, google.maps.Marker>>(new Map());
  const info = useRef<google.maps.InfoWindow | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY as string | undefined;

  /** Only rows that can actually be placed. */
  const plotted = useMemo(
    () => branches.filter((branch) => branch.latitude != null && branch.longitude != null),
    [branches],
  );

  useEffect(() => {
    if (!key) {
      setError("Google Maps is not connected.");
      return;
    }
    let cancelled = false;
    loadMapsSdk(key)
      .then((maps) => {
        if (cancelled || !container.current || map.current) return;
        map.current = new maps.Map(container.current, {
          center: { lat: KSA_CENTER.lat, lng: KSA_CENTER.lng },
          zoom: 5,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          clickableIcons: false,
        });
        info.current = new maps.InfoWindow();
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("Google Maps could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  /** Palette follows the portal theme. */
  useEffect(() => {
    if (!ready || !map.current) return;
    map.current.setOptions({ styles: theme === "dark" ? DARK_STYLES : [] });
  }, [ready, theme]);

  /** Markers mirror the filtered set; the view fits whatever is left. */
  useEffect(() => {
    if (!ready || !map.current || !window.google?.maps) return;
    const maps = window.google.maps;
    const current = markers.current;
    const wanted = new Set(plotted.map((branch) => branch.branch_no));

    for (const [code, marker] of current) {
      if (!wanted.has(code)) {
        marker.setMap(null);
        current.delete(code);
      }
    }

    for (const branch of plotted) {
      const position = { lat: branch.latitude as number, lng: branch.longitude as number };
      let marker = current.get(branch.branch_no);
      if (!marker) {
        marker = new maps.Marker({
          position,
          map: map.current,
          title: `${branch.branch_no} — ${branch.city}`,
        });
        marker.addListener("click", () => {
          info.current?.setContent(infoHtml(branch));
          info.current?.open({ anchor: marker, map: map.current ?? undefined });
          onSelect(branch.branch_no);
        });
        current.set(branch.branch_no, marker);
      } else {
        marker.setPosition(position);
      }
    }

    if (plotted.length === 0) return;
    if (plotted.length === 1) {
      map.current.setCenter({
        lat: plotted[0].latitude as number,
        lng: plotted[0].longitude as number,
      });
      map.current.setZoom(14);
      return;
    }
    const bounds = new maps.LatLngBounds();
    for (const branch of plotted) {
      bounds.extend({ lat: branch.latitude as number, lng: branch.longitude as number });
    }
    map.current.fitBounds(bounds, 32);
  }, [ready, plotted, onSelect]);

  /** Selecting a branch anywhere focuses it here. */
  useEffect(() => {
    if (!ready || !map.current || !selected) return;
    const branch = plotted.find((entry) => entry.branch_no === selected);
    const marker = markers.current.get(selected);
    if (!branch || !marker) return;
    map.current.panTo({ lat: branch.latitude as number, lng: branch.longitude as number });
    if ((map.current.getZoom() ?? 5) < 13) map.current.setZoom(14);
    info.current?.setContent(infoHtml(branch));
    info.current?.open({ anchor: marker, map: map.current });
  }, [ready, selected, plotted]);

  /** Drop every marker when the map leaves the page. */
  useEffect(
    () => () => {
      for (const marker of markers.current.values()) marker.setMap(null);
      markers.current.clear();
      info.current?.close();
      map.current = null;
    },
    [],
  );

  return (
    <section aria-label="Branch map" className="relative overflow-hidden rounded-xl border bg-card">
      <div ref={container} className="h-[320px] w-full sm:h-[380px]" />
      {(error || !ready) && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-card/70 text-sm text-muted-foreground">
          {error ?? "Loading map…"}
        </div>
      )}
      {ready && !error && plotted.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-card/85 p-2 text-center text-xs text-muted-foreground">
          No branches with coordinates in the current filter.
        </div>
      )}
    </section>
  );
}

export default BranchMap;
