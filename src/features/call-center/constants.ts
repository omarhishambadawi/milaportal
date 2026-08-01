import type { CSSProperties } from "react";
import type { Tone } from "./types";

export const tooltipStyle: CSSProperties = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  fontSize: 12,
  boxShadow: "0 6px 20px -10px rgba(0,0,0,.25)",
  color: "var(--color-foreground)",
};

/**
 * A hairline colour stripe down the left edge of a KPI card, used to group
 * cards that answer the same kind of question (queue volume vs. timing vs.
 * agent performance).
 *
 * Deliberately at 40% opacity on the existing tone palette rather than a new
 * set of colours: the page has to stay readable as a monochrome print-out, so
 * grouping is a supporting cue, never the only one — the section header above
 * the grid still carries the meaning.
 */
export const accentMap: Record<Tone, string> = {
  primary: "border-l-primary/40",
  secondary: "border-l-secondary/40",
  success: "border-l-success/40",
  warning: "border-l-warning/40",
  destructive: "border-l-destructive/40",
  muted: "border-l-border",
};

export const toneMap: Record<
  Tone,
  { text: string; ring: string; iconBg: string; iconText: string }
> = {
  primary: {
    text: "text-primary",
    ring: "ring-primary/20",
    iconBg: "bg-primary/10",
    iconText: "text-primary",
  },
  secondary: {
    text: "text-secondary",
    ring: "ring-secondary/20",
    iconBg: "bg-secondary/10",
    iconText: "text-secondary",
  },
  success: {
    text: "text-success",
    ring: "ring-success/20",
    iconBg: "bg-success/10",
    iconText: "text-success",
  },
  warning: {
    text: "text-warning",
    ring: "ring-warning/20",
    iconBg: "bg-warning/10",
    iconText: "text-warning",
  },
  destructive: {
    text: "text-destructive",
    ring: "ring-destructive/20",
    iconBg: "bg-destructive/10",
    iconText: "text-destructive",
  },
  muted: {
    text: "text-foreground",
    ring: "ring-border",
    iconBg: "bg-muted",
    iconText: "text-muted-foreground",
  },
};
