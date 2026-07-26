import { useCallback, useEffect, useMemo, useState } from "react";
import type { Layout } from "react-resizable-panels";
import {
  MAP_DEFAULT_WIDTH,
  MAP_MAX_WIDTH,
  MAP_MIN_WIDTH,
  MAP_VISIBLE_KEY,
  MAP_WIDTH_KEY,
} from "../constants";

/** Panel ids, shared between the hook and the route's layout. */
export const LIST_PANEL_ID = "branch-list";
export const MAP_PANEL_ID = "branch-map";

/** The split is only offered once there is room for a list *and* a map. */
const WIDE_QUERY = "(min-width: 1024px)";

/**
 * The map's share of the screen, remembered per device.
 *
 * Three things the directory needs and a plain flex split could not give it:
 *
 *   - **A smaller default.** The map used to take 46% of the row, which is a lot
 *     of screen for a supporting view — and it cost the list its second column
 *     on a 1440px laptop. At 28% the list is wide enough for two, often three.
 *   - **A drag.** Some calls are "where is this branch", most are "what are its
 *     hours". Whoever is on the call is the only one who knows which, so the
 *     ratio is theirs to set, not ours.
 *   - **Persistence**, because setting it every morning is not a feature.
 */
export function useMapPanel() {
  const [wide, setWide] = useState(false);
  const [visible, setVisible] = useState(true);
  const [storedWidth, setStoredWidth] = useState<number | null>(null);

  /**
   * Preferences are read after mount, never during render.
   *
   * This page is server-rendered, and markup that depends on a value only the
   * browser has is a hydration mismatch.
   */
  useEffect(() => {
    const media = window.matchMedia(WIDE_QUERY);
    const sync = () => setWide(media.matches);
    sync();
    media.addEventListener("change", sync);

    try {
      if (window.localStorage.getItem(MAP_VISIBLE_KEY) === "0") setVisible(false);
      const raw = Number(window.localStorage.getItem(MAP_WIDTH_KEY));
      if (Number.isFinite(raw) && raw >= MAP_MIN_WIDTH && raw <= MAP_MAX_WIDTH) {
        setStoredWidth(raw);
      }
    } catch {
      /* private mode, or a hand-edited value. The default is a fine answer. */
    }

    return () => media.removeEventListener("change", sync);
  }, []);

  const showPanel = wide && visible;
  const width = storedWidth ?? MAP_DEFAULT_WIDTH;

  const defaultLayout: Layout = useMemo(
    () => ({ [LIST_PANEL_ID]: 100 - width, [MAP_PANEL_ID]: width }),
    [width],
  );

  /**
   * Changes whenever the set of panels in the group changes.
   *
   * Used as the group's `key`, which is what makes the remembered width apply.
   * `defaultLayout` is read when the group mounts, and the map panel is not there
   * for the first render — the media query has not resolved and localStorage has
   * not been read. A panel that joins a group already claiming the full width is
   * handed what is left, which is nothing: it appears as a 2%-wide sliver. Keying
   * the group means it mounts once with every panel present and the stored
   * layout in hand. The cost is the list's scroll position when the map is
   * toggled, which is a deliberate act on an unscrolled-or-not list; the
   * alternative was a map nobody could see.
   */
  const layoutKey = `${showPanel ? "split" : "solo"}:${width}`;

  const toggle = useCallback(() => {
    setVisible((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(MAP_VISIBLE_KEY, next ? "1" : "0");
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, []);

  /**
   * Persist a finished drag.
   *
   * `onLayoutChanged` fires on pointer *release*, not per frame, so this is one
   * write per resize rather than one per mouse move. It deliberately does not
   * feed `storedWidth` back into state: that would change `layoutKey` and remount
   * the group the instant the agent let go of the handle.
   */
  const remember = useCallback((layout: Layout) => {
    const next = layout[MAP_PANEL_ID];
    if (typeof next !== "number" || next <= 0) return;
    try {
      window.localStorage.setItem(MAP_WIDTH_KEY, String(Math.round(next)));
    } catch {
      /* best-effort */
    }
  }, []);

  return {
    /** The map panel should be rendered: wide enough, and not hidden. */
    showPanel,
    /** True once the viewport is wide enough for the split, hidden map or not. */
    wide,
    visible,
    layoutKey,
    defaultLayout,
    /**
     * Sizes as percent *strings*, and that is not cosmetic: a `Panel` reads a
     * bare number as **pixels**. `minSize={18}` is an 18-pixel panel, which the
     * library then honours to the letter.
     */
    minWidth: `${MAP_MIN_WIDTH}%`,
    maxWidth: `${MAP_MAX_WIDTH}%`,
    /** Floor for the list, so the map can never squeeze the cards out. */
    listMinWidth: `${100 - MAP_MAX_WIDTH}%`,
    toggle,
    remember,
  };
}
