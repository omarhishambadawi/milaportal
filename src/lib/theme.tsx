import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";
type ThemeCtx = { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };

const Ctx = createContext<ThemeCtx | null>(null);
const STORAGE_KEY = "milaserv.theme";

/**
 * The cross-fade used on browsers without view transitions.
 *
 * Split rather than symmetric: covering the outgoing palette can be brisk
 * because there is nothing to look at yet, while revealing the incoming one is
 * the part that should feel like a dissolve. 200ms total, matching
 * --theme-duration and therefore the view-transition path.
 */
const COVER_MS = 90;
const REVEAL_MS = 110;
const FADE_EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** Id of the cross-fade layer; styled in src/styles.css. */
const OVERLAY_ID = "theme-cross-fade";

/** Browser chrome colour (mobile address bar) — approximates --background per theme. */
const THEME_COLOR: Record<Theme, string> = { light: "#fbfdfd", dark: "#171b26" };

/*
 * Theme lives in the DOM, not in React.
 *
 * A theme change is one synchronous class flip on <html>; every colour in the
 * app resolves from that class through CSS variables and `dark:` variants, so
 * the whole tree repaints on a single frame. React is only told afterwards, and
 * only so the toggle button can label itself — no component re-renders to pick
 * up a colour, which is what used to make the sidebar logo and charts land a
 * beat after everything else.
 */
const listeners = new Set<() => void>();

function readDom(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

let current: Theme = typeof document === "undefined" ? "light" : readDom();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

const getSnapshot = () => current;
/** SSR always renders Light; the pre-hydration script fixes the DOM before paint. */
const getServerSnapshot = (): Theme => "light";

/** The colour change itself: one class flip, no animation of any kind. */
function applyDom(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/**
 * The cross-fade layer, created once and reused.
 *
 * Painted with the background colour that is *currently on screen*, read off
 * the computed style rather than the THEME_COLOR table, so it matches whatever
 * the page is actually showing — including mid-swap, if someone toggles twice
 * in 150ms.
 */
function coverLayer(): HTMLDivElement {
  let overlay = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlay);
  }
  const painted = getComputedStyle(document.documentElement)
    .getPropertyValue("--background")
    .trim();
  overlay.style.background = painted || THEME_COLOR[current];
  return overlay;
}

/**
 * Two paths, and the invariant both satisfy: **the palette flip is never
 * visible as a partial frame.**
 *
 * The thing that must not happen is the browser painting a frame in which some
 * of the page has taken the new palette and some has not. That is what the
 * remaining flicker reports were — banding across table rows, sticky headers
 * strobing — and it is a rendering-pipeline problem, not a timing one, so no
 * amount of adjusting durations fixes it.
 *
 * PATH 1 — view transitions (Chromium, Safari 18+).
 *
 * The browser snapshots the current rendering, applies the theme in ONE restyle,
 * snapshots the result, and cross-fades the two textures on the compositor.
 * Each snapshot is a *complete* rendering, so a half-updated frame is not
 * representable. Nothing unmounts, React never re-renders, scroll is untouched.
 *
 * PATH 2 — a cover layer (Firefox, older Safari, anything else).
 *
 * This replaces interpolating the design tokens, which is what shipped here
 * before and is the actual root cause of the inconsistency across browsers. The
 * 49 tokens are registered `@property` values with `inherits: true`, so
 * animating them on :root invalidates inherited style for the *entire document*
 * every frame. On a large orders table one such recalculation costs 14–18ms —
 * at or past the whole frame budget before any painting — so over a 200ms swap
 * the compositor ships a dozen partial repaints. Firefox has no
 * `startViewTransition`, so Firefox users were getting precisely the expensive
 * path the view transition exists to avoid; and any engine without registered-
 * property interpolation got no fade at all, just a hard snap between two very
 * different palettes.
 *
 * So instead: fade one full-viewport layer, painted with the background colour
 * currently on screen, up to opaque; flip the theme while it is covered; fade it
 * back down. Two opacity animations on one element is pure compositor work, the
 * style recalculation happens exactly once and behind cover, and none of it
 * depends on `@property` support. It is never white — the layer is the outgoing
 * theme's own background — and it behaves identically on every engine.
 *
 * Under `prefers-reduced-motion` both paths are skipped and the flip is
 * instant, which is also flicker-free: one restyle, one paint.
 */
function apply(theme: Theme) {
  const root = document.documentElement;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  if (reduce) {
    applyDom(theme);
    return;
  }

  const startViewTransition = (
    document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    }
  ).startViewTransition;

  if (typeof startViewTransition === "function") {
    // Suppresses per-element transitions so nothing is still easing when the
    // "after" snapshot is taken — a component mid `transition-colors` would be
    // captured at its start value and then animate a second time, live, once
    // the cross-fade hands back to the real DOM.
    root.classList.add("theme-vt");
    const done = () => root.classList.remove("theme-vt");
    try {
      // Rejects when a rapid re-toggle skips this transition; both arms clean
      // up, and passing two handlers (rather than .finally) keeps that
      // rejection from surfacing as an unhandled promise.
      startViewTransition.call(document, () => applyDom(theme)).finished.then(done, done);
      return;
    } catch {
      // An engine that exposes the method but refuses the call (a hidden
      // document, an implementation quirk) must not be left mid-swap with the
      // suppression class on and the old palette still showing.
      done();
    }
  }

  crossFade(theme);
}

/**
 * Which cross-fade currently owns the layer.
 *
 * Toggling twice inside 200ms is a thing people do, and both fades share one
 * overlay element. Cancelling the first one's animations rejects its `finished`
 * promise, whose handler would otherwise apply *its* theme and remove a layer
 * the second fade is already animating — leaving the wrong palette on screen
 * under no cover at all. Every continuation checks it still holds the token.
 */
let fadeToken = 0;

/** Path 2. See `apply`. */
function crossFade(theme: Theme) {
  const root = document.documentElement;
  const overlay = coverLayer();
  const token = ++fadeToken;
  const mine = () => token === fadeToken;

  // The in-flight animations of a superseded fade would fight this one over the
  // layer's opacity and leave it stuck part-way.
  for (const animation of overlay.getAnimations()) animation.cancel();

  // Pins every element to the current token value for the duration, so nothing
  // is still easing its own `transition-colors` when the layer comes back down.
  root.classList.add("theme-switching");

  const settle = () => {
    if (!mine()) return;
    root.classList.remove("theme-switching");
    overlay.remove();
  };

  overlay
    .animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: COVER_MS,
      easing: FADE_EASE,
      fill: "forwards",
    })
    .finished.then(() => {
      if (!mine()) return;
      applyDom(theme);
      // Repaint the layer in the *new* background before revealing, so the
      // dissolve ends on the colour the page is about to be rather than
      // stepping from the old one at the last frame.
      overlay.style.background =
        getComputedStyle(root).getPropertyValue("--background").trim() || THEME_COLOR[theme];
      return overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: REVEAL_MS,
        easing: FADE_EASE,
        fill: "forwards",
      }).finished;
    })
    .then(settle, () => {
      // Superseded, or the Web Animations API refused. If this fade is still the
      // current one the theme must end up applied regardless — a failed
      // animation must never leave the page on the old palette.
      if (!mine()) return;
      applyDom(theme);
      settle();
    });
}

function setTheme(theme: Theme) {
  if (typeof document === "undefined" || theme === current) return;
  apply(theme);
  current = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {}
  for (const cb of listeners) cb();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Keep other tabs in step.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setTheme(e.newValue === "dark" ? "dark" : "light");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeCtx>(
    () => ({ theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") }),
    [theme],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx) ?? { theme: "light", setTheme: () => {}, toggle: () => {} };
}

/**
 * Inline script — runs synchronously before first paint to prevent FOUC.
 * Default: Light Mode. Only opts into Dark when the user has explicitly saved it.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var d=localStorage.getItem('${STORAGE_KEY}')==='dark';var r=document.documentElement;if(d)r.classList.add('dark');r.style.colorScheme=d?'dark':'light';var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',d?'${THEME_COLOR.dark}':'${THEME_COLOR.light}');}catch(e){}})();`;
