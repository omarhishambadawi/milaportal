/**
 * The order workspace's shared surfaces and type — one definition for the page.
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
  /** The card's header band, which is also its heaviest internal rule. */
  header: string;
  /** The card's content. */
  body: string;
  /**
   * Every other rule inside the card — a section break, a row separator, the
   * line above a footer of actions.
   *
   * One token because the panels had reached three weights between them
   * (`border-border`, `/60`, `/40`) for lines doing the same job, and a card
   * whose internal rules all differ slightly reads as several cards.
   */
  divider: string;
}

/** The main column's cards — the workspace an agent fills in. */
export const PANEL_MAIN: PanelShell = {
  surface: "overflow-hidden border-border/60 shadow-xs dark:shadow-none",
  header: "border-b border-border/50 bg-muted/20 px-5 py-3.5 dark:bg-muted/10",
  body: "p-5",
  divider: "border-border/50",
};

/** The context column's panels — what the portal found, beside the form. */
export const PANEL_CONTEXT: PanelShell = {
  surface: "overflow-hidden border-border/60 shadow-none",
  header: "border-b border-border/50 bg-muted/20 px-4 py-3 dark:bg-muted/10",
  body: "p-4",
  divider: "border-border/50",
};

/**
 * One field of a context panel: a small muted label over its value.
 *
 * The invoice panel and the dispatch card each had their own — 10.5px uppercase
 * over `text-sm font-medium` in one, 11px uppercase over `text-sm font-medium`
 * in the other — which is close enough to look like a mistake when the two sit
 * one above the other in the same column. `text-[13px]` on the value rather than
 * `text-sm`: these are facts to scan down, not sentences to read, and 14px in a
 * two-up grid was the largest type in a column that is supposed to support the
 * form rather than compete with it.
 */
export const PANEL_FIELD = {
  label: "text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground",
  value: "text-[13px] font-medium leading-snug text-foreground",
} as const;

/**
 * One control on the editing side of the page, and the name of a group of them.
 *
 * The mirror of `PANEL_FIELD`, and deliberately a step louder: the left column
 * is edited and the right column is read, so a form label is `font-semibold` in
 * the foreground while a panel label is `font-medium` and muted. The two share a
 * size and a case at the group level, which is what makes the columns read as
 * one design rather than two.
 *
 * It exists because the labels had drifted apart across three files — the order
 * form's `Field` at `text-xs font-semibold`, the AlShrouq requirements at
 * `text-xs font-medium`, its coordinates at `text-[11px] font-medium` and muted —
 * for controls that sit inside the same card, one under another.
 */
export const FORM_FIELD = {
  /** A control's own label, beside its required marker. */
  label: "flex items-center gap-1.5 text-xs font-semibold",
  /**
   * The name of a group of controls.
   *
   * Uppercase and small so that a group can be recognised without being read,
   * which is the whole reason the groups are named: an agent scanning for the
   * customer's phone number should find the block by its shape rather than by
   * reading six field labels.
   */
  group: "text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground",
  /** The line under a control, and the quietest thing in a card. */
  hint: "text-[11px] leading-snug text-muted-foreground",
} as const;
