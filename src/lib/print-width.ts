/**
 * The printable width of an A4 portrait page, in CSS pixels.
 *
 * 210mm of paper less the 12mm side margins declared by `@page` in `styles.css`
 * leaves 186mm, and CSS defines 1in as 96px, so 186mm ÷ 25.4 × 96 ≈ 703.
 *
 * This exists because Recharts' `ResponsiveContainer` measures its parent
 * through a `ResizeObserver`, and a `ResizeObserver` callback is delivered
 * asynchronously — before the *next* frame's paint. `window.print()` is
 * synchronous, so when the print box is narrower than the screen the chart SVG
 * is still the width it had on screen and the browser has to squeeze it into the
 * page. Laying the report out at exactly this width *before* calling print means
 * the measurement Recharts takes is the measurement the page gets, and no
 * squeezing happens at all.
 */
export const PRINT_WIDTH_PX = 703;
