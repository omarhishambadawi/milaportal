/**
 * The order form's layout contract.
 *
 * Nothing renders here — the suite runs in Node, because every other unit under
 * test is a pure function and adding a DOM for one file would be a dependency
 * with no other test to justify it. So what is asserted is the *source*: the
 * handful of decisions that are invisible in a type check, break silently, and
 * are exactly what a later edit tidying up class names would undo.
 *
 * The source is `features/orders/components/order-form.tsx`. It used to be
 * `routes/_app.orders.new.tsx`, which is also where the form itself used to
 * live; the form moved out of the route file so it would stop shipping in the
 * entry bundle, and this contract moved with it. Reading a route file that no
 * longer holds the markup would make every assertion below vacuously pass.
 *
 * Each one exists for a reason:
 *
 *   * the two columns must appear only where there is width for them, or a
 *     phone gets a 26rem panel beside a form;
 *   * the workflow column must come first in the document, or stacking puts the
 *     read-only findings above the fields an agent is trying to fill in;
 *   * the header's submit button lives outside the `form` element and reaches
 *     it by id — remove the id and the primary action silently stops working;
 *   * the invoice panel and the timeline must be the shared components, not a
 *     second implementation of either.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../components/order-form.tsx", import.meta.url)),
  "utf8",
);

describe("two-column workspace", () => {
  it("splits into two columns only from the xl breakpoint", () => {
    // 60/40 in fractions, not a fixed right-hand width. `minmax(0,26rem)` made
    // the verification column a sidebar — under 30% of the page — which starved
    // the invoice's customer, channel and item lines while the form's fields
    // swam in whitespace opposite.
    expect(source).toContain("xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]");
    // A single-column `grid` below that breakpoint: no `md:`/`lg:` column rule
    // anywhere on the page shell.
    expect(source).not.toMatch(/\bmd:grid-cols-\[/);
    expect(source).not.toMatch(/\blg:grid-cols-\[/);
  });

  it("puts the workflow column first, so stacking keeps the fields on top", () => {
    expect(source.indexOf(`<form id={FORM_ID}`)).toBeLessThan(source.indexOf("<aside"));
  });

  it("gives the page exactly one scrollbar", () => {
    // The verification column used to be `sticky` with a capped height and
    // `overflow-y: auto`, which meant two scrolling regions a few pixels apart
    // and a wheel gesture that did different things depending on where the
    // pointer was. Both columns are in the document scroll now, so neither of
    // these may come back on the page shell.
    expect(source).not.toMatch(/overflow-y-auto/);
    expect(source).not.toMatch(/max-h-\[calc\(100vh/);
    expect(source).not.toMatch(/<aside[^>]*sticky/);
  });

  it("top-aligns the columns rather than stretching the shorter one", () => {
    expect(source).toContain("items-start");
  });

  it("cannot scroll the page sideways", () => {
    // `minmax(0,…)` tracks and `min-w-0` on both columns: a grid child's default
    // `min-width: auto` is what lets a long invoice customer name push the whole
    // page wider than the viewport.
    expect(source).toContain("minmax(0,1fr)");
    expect(source).toMatch(/<form id=\{FORM_ID\}[^>]*className="min-w-0/);
    expect(source).toMatch(/<aside className="min-w-0/);
    expect(source).not.toContain("overflow-x-auto");
  });

  it("keeps every field grid two-up at most, so a column never gets cramped", () => {
    // `sm:grid-cols-2` inside a card, not `md:`/`lg:`: the cards live in a
    // column roughly half the page, so the breakpoint that matters is the
    // card's own width, not the viewport's.
    expect(source).toContain("sm:grid-cols-2");
    expect(source).not.toContain("md:grid-cols-3");
  });
});

describe("primary actions", () => {
  it("are in the page header, reaching the form by id", () => {
    expect(source).toContain('const FORM_ID = "order-form";');
    expect(source).toContain("<form id={FORM_ID}");

    /*
     * The invariant is that the header's action reaches the form *by id* rather
     * than living inside it — that is what lets it sit in the page header at
     * all. It used to be a single literal; a new AlShrouq order now opens an
     * approval dialog first, so the attribute is conditional. Both paths still
     * go through FORM_ID, and both are asserted rather than the old literal.
     */
    expect(source).toMatch(/form=\{[^}]*FORM_ID[^}]*\}/);
    expect(source).toContain('type={interceptsCreate ? "button" : "submit"}');
    // The AlShrouq path submits the same form, by the same id.
    expect(source).toContain("getElementById(FORM_ID)");
  });

  it("keeps the approval dialog out of the form element", () => {
    // Nested inside <form>, its buttons would submit on click. It is a sibling.
    const formStart = source.indexOf("<form id={FORM_ID}");
    const formEnd = source.indexOf("</form>");
    const inside = source.slice(formStart, formEnd);
    expect(inside).not.toContain("AlShrouqCreateApproval");
  });

  it("offer Cancel beside them", () => {
    expect(source).toContain('{readOnly ? "Close" : "Cancel"}');
  });

  it("sit under a breadcrumb that names where this page is", () => {
    expect(source).toContain('aria-label="Breadcrumb"');
  });
});

describe("the verification column consumes the existing systems", () => {
  it("renders the shared invoice panel rather than a second one", () => {
    expect(source).toContain("OrderInvoicePanel");
    expect(source).toContain("@/features/orders/components/order-invoice-panel");
  });

  it("renders the shared timeline rather than a second one", () => {
    expect(source).toContain("OrderActivityTimeline");
    expect(source).toContain("@/features/orders/components/order-activity-timeline");
  });

  it("gates the invoice panel on the Shams permission", () => {
    expect(source).toContain("{canViewShams && <OrderInvoicePanel");
  });

  it("keeps the findings outside the fieldset a read-only role disables", () => {
    // Inside it, the people reviewing an order would be the ones who cannot see
    // what was found.
    const fieldsetEnd = source.indexOf("</fieldset>");
    expect(fieldsetEnd).toBeGreaterThan(-1);
    expect(source.indexOf("<OrderInvoicePanel")).toBeGreaterThan(fieldsetEnd);
  });
});

describe("the Call Center control", () => {
  it("sits in the operational section, not among the invoice fields", () => {
    expect(source).toContain("CallCenterInvoiceField");
    expect(source.indexOf("<CallCenterInvoiceField")).toBeGreaterThan(
      source.indexOf('title="Assignment"'),
    );
  });

  it("is told whether the tick was the portal's doing", () => {
    expect(source).toContain("automated={shamsInvoices.callCentreVerified}");
  });

  it("is operable only by someone who may verify", () => {
    expect(source).toContain("canVerify={canVerifyThis}");
  });
});
