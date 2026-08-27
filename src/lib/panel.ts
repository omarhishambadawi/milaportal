/**
 * The workspace panel shell — one definition for every card on the order page.
 *
 * The order page is four editable cards beside three read-only panels, and each
 * of the seven had grown its own copy of the same three class strings: the
 * surface, the tinted header band, the body padding. They had already started to
 * drift — two different border tints, two header paddings — and the page read as
 * a collection of panels from different screens rather than as one workspace.
 *
 * They are two constants rather than one because the difference between the
 * columns **is** the hierarchy. The main column is where an agent works, so its
 * cards carry a hairline of elevation and a slightly wider measure. The context
 * column is what the portal found, read rather than edited, so its panels are
 * flat and a shade denser: present, and plainly secondary to the form.
 *
 * Colour and radius come from `Card` and the design tokens — nothing new is
 * introduced here. What these override is the *weight*: `border-border/60`
 * instead of the full-strength border, and `shadow-xs`/none instead of `Card`'s
 * default `shadow`, because a page of seven cards is where a default border and
 * a default shadow stop reading as structure and start reading as noise.
 */

export interface PanelShell {
  /** Goes on the `Card` itself, beside its own `rounded-xl border bg-card`. */
  surface: string;
  /** The card's header band, which is also its only internal divider. */
  header: string;
  /** The card's content. */
  body: string;
}

/** The main column's cards — the workspace an agent fills in. */
export const PANEL_MAIN: PanelShell = {
  surface: "overflow-hidden border-border/60 shadow-xs dark:shadow-none",
  header: "border-b border-border/50 bg-muted/20 px-5 py-3.5 dark:bg-muted/10",
  body: "p-5",
};

/** The context column's panels — what the portal found, beside the form. */
export const PANEL_CONTEXT: PanelShell = {
  surface: "overflow-hidden border-border/60 shadow-none",
  header: "border-b border-border/50 bg-muted/20 px-4 py-3 dark:bg-muted/10",
  body: "p-4",
};
