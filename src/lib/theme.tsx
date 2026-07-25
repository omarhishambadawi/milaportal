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

/** Mirrors --theme-duration in src/styles.css. */
const TRANSITION_MS = 200;

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

let resetTimer: ReturnType<typeof setTimeout> | undefined;

/** The colour change itself: one class flip, no animation of any kind. */
function applyDom(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/**
 * Why this does not simply interpolate the tokens.
 *
 * The 49 design tokens are registered `@property` values with `inherits: true`,
 * so animating them on :root means every animation frame invalidates inherited
 * style for the *entire document* and repaints it. Measured on a 4,200-node
 * table, one such full-tree recalculation costs 14–18ms — at or past the whole
 * 16.7ms frame budget, before any painting. Over a 200ms swap that is ~12
 * consecutive over-budget frames, so the compositor ships partial repaints: the
 * banding across table rows that this replaces, where some rows had taken the
 * new palette and others had not.
 *
 * A view transition inverts the cost. The browser snapshots the current
 * rendering, applies the theme in ONE restyle, snapshots the result, and
 * cross-fades the two textures on the compositor. Style is recalculated once
 * instead of twelve times, the fade itself is pure GPU opacity, and — the part
 * that actually fixes the reported bug — each snapshot is a *complete*
 * rendering, so a half-updated frame is not representable. Nothing unmounts,
 * React never re-renders, and scroll position is untouched.
 *
 * Browsers without the API fall back to the token interpolation below, which
 * looks the same and is merely more expensive.
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
    // Rejects when a rapid re-toggle skips this transition; both arms clean up,
    // and passing two handlers (rather than .finally) keeps that rejection from
    // surfacing as an unhandled promise.
    startViewTransition.call(document, () => applyDom(theme)).finished.then(done, done);
    return;
  }

  // Fallback: arm the token interpolation in the same style recalculation as the
  // colour change. Transitions take their timing from the after-change style, so
  // one pass is enough — no forced reflow, no second frame.
  root.classList.add("theme-switching");
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    root.classList.remove("theme-switching");
    resetTimer = undefined;
  }, TRANSITION_MS + 50);

  applyDom(theme);
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
