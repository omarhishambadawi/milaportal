/**
 * The parts of the PDF that exist only on paper.
 *
 * The export is `window.print()` — the browser's own writer over the real DOM,
 * so the text stays selectable and the charts stay vector. What a browser will
 * not supply is the masthead and the footer a report going to management is
 * expected to carry, and those are what this file adds. Nothing here renders on
 * screen.
 *
 * Brand colours are literal hex rather than the theme tokens, and deliberately:
 * these two elements must look the same on every sheet regardless of which theme
 * the export was run from, and #25BDBC / #3D6D6C / #2B3346 are the identity the
 * rest of the portal's palette is derived from anyway.
 */

const TURQUOISE = "#25BDBC";
const TEAL = "#3D6D6C";
const NAVY = "#2B3346";

/** "10 August 2026" — how the footer dates itself. */
function generatedOn(): string {
  return new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * The masthead, printed once at the top of the first sheet.
 *
 * Not `position: fixed`, so it does not repeat: a report identifies itself once
 * and the running footer carries the identity on every sheet after that.
 */
export function ReportPrintHeader({ title, period }: { title: string; period: string }) {
  return (
    <div
      className="hidden print:mb-4 print:block print:break-after-avoid"
      style={{ borderBottom: `2px solid ${TURQUOISE}`, paddingBottom: "3mm" }}
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <div
            style={{
              color: TURQUOISE,
              fontSize: "9pt",
              fontWeight: 700,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
            }}
          >
            MilaServ Portal
          </div>
          <div style={{ color: NAVY, fontSize: "17pt", fontWeight: 700, lineHeight: 1.2 }}>
            {title}
          </div>
        </div>
        <div style={{ color: TEAL, fontSize: "10pt", textAlign: "right" }}>
          <div style={{ fontWeight: 600 }}>{period}</div>
          <div style={{ fontSize: "8pt" }}>Generated {generatedOn()}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The running footer, repeated on every sheet.
 *
 * `.print-footer` (see the `@media print` block in `styles.css`) fixes it into
 * the page's bottom margin, which is the only footer mechanism available here:
 * Chromium implements neither `@page` margin boxes nor `counter(page)`, so the
 * sheet number is left to the browser's own print options rather than faked.
 */
export function ReportPrintFooter({ label }: { label: string }) {
  return (
    <div className="print-footer hidden">
      <span>MilaServ Portal · {label}</span>
      <span>Generated {generatedOn()} · Confidential</span>
    </div>
  );
}
