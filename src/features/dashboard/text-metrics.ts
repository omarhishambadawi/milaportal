/**
 * Real text measurement for chart axes.
 *
 * A category axis has to reserve its width *before* the labels are painted, and
 * Recharts will not do it — `YAxis width` is a number you supply, and anything
 * wider than it is silently clipped. The previous fixed widths (130 for agents,
 * 80 for branches, 90 for cities) were guesses made against short English names;
 * a full Arabic city name or a three-part agent name simply ran off the edge.
 *
 * Estimating from `label.length * someFactor` does not survive this data set —
 * Arabic glyphs, Latin capitals and digits have wildly different advance widths,
 * and the estimate has to be conservative enough for the worst case, which means
 * wasting a third of the plot area on every ordinary label. Canvas gives the
 * exact number for the font actually in use, for the cost of one offscreen
 * context that lives for the life of the page.
 */

let ctx: CanvasRenderingContext2D | null | undefined;
let fontFamily: string | null = null;

function measureContext(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  return ctx;
}

/**
 * The page's own body font, so measurements match what SVG will render.
 *
 * Read once — it cannot change without a stylesheet swap, and `getComputedStyle`
 * in a loop over every label on every resize is exactly the kind of forced
 * reflow that makes a chart feel heavy.
 */
function bodyFontFamily(): string {
  if (fontFamily != null) return fontFamily;
  fontFamily =
    typeof document === "undefined"
      ? "sans-serif"
      : getComputedStyle(document.body).fontFamily || "sans-serif";
  return fontFamily;
}

/** Width of `text` in px at `fontSize`, in the page's body font. */
export function measureText(text: string, fontSize: number, weight = 400): number {
  const c = measureContext();
  // Server-side and in a jsdom-less test there is no canvas. The fallback is
  // deliberately generous: over-reserving an axis looks slightly airy, while
  // under-reserving it clips a name, and only one of those is a bug.
  if (!c) return text.length * fontSize * 0.62;
  c.font = `${weight} ${fontSize}px ${bodyFontFamily()}`;
  return c.measureText(text).width;
}

/** The widest of `labels`, in px. */
export function widestLabel(labels: string[], fontSize: number, weight = 400): number {
  let widest = 0;
  for (const l of labels) {
    const w = measureText(l, fontSize, weight);
    if (w > widest) widest = w;
  }
  return widest;
}

/**
 * `label`, shortened with an ellipsis until it fits `maxWidth`.
 *
 * Binary search rather than a character-count guess, because the whole reason
 * this module exists is that character count does not predict width. Returns the
 * original string untouched when it already fits, so callers can compare
 * identity to decide whether a tooltip is warranted.
 */
export function ellipsize(label: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return label;
  if (measureText(label, fontSize) <= maxWidth) return label;

  const ellipsis = "…";
  const budget = maxWidth - measureText(ellipsis, fontSize);
  if (budget <= 0) return ellipsis;

  let lo = 0;
  let hi = label.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(label.slice(0, mid), fontSize) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return label.slice(0, lo).trimEnd() + ellipsis;
}
