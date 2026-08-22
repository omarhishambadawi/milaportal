/**
 * How an AlShrouq dispatch *looks*, and what it *means* — in one place.
 *
 * `dispatch-timeline.ts` already decides what each state is called. This decides
 * the two things a screen needs on top of that name: the sentence that tells an
 * agent what the state means for them, and the colour the design system uses to
 * say the same thing without words.
 *
 * ## Why the sentence exists at all
 *
 * "Scheduled" and "Delivery status unavailable" are accurate labels and neither
 * answers the question an agent actually has, which is *what do I do now*. A
 * scheduled delivery needs nothing from anyone; an unconfirmed one needs a phone
 * call and must not be sent again. A badge cannot carry that distinction, so the
 * card carries a line beneath it and this is where that line is written.
 *
 * ## Why it is pure, and here rather than in the component
 *
 * Every test in this repository runs in Node with nothing rendered. Keeping the
 * wording and the tone mapping in a module means the vocabulary an agent reads
 * is asserted the same way the rest of this feature is — over values, not over a
 * DOM — and the card, the approval dialog and the timeline cannot drift into
 * three different accounts of one row.
 *
 * The class strings are the portal's own tokens (`primary`, `success`,
 * `warning`, `destructive`, `muted`) exactly as `StateTag` and the call-centre
 * tables already use them. No colour is introduced here.
 */

import type { AlShrouqDispatchSummary } from "./dispatch-timeline";

/** The five tones `summariseAlShrouqDispatch` reports. */
export type AlShrouqTone = AlShrouqDispatchSummary["tone"];

export interface AlShrouqToneStyle {
  /** A pill: the status badge on the card, and the step marker in a dialog. */
  badge: string;
  /** A full-width band, for a state that needs a sentence rather than a chip. */
  band: string;
  /** The icon inside a band or a pill. */
  icon: string;
}

/**
 * Tone → the portal's existing utility classes.
 *
 * `info` is the brand turquoise rather than a new blue: a scheduled delivery is
 * the portal's own state, not a warning and not a success, and `primary/10` is
 * what every other "this is in hand" surface in the app already uses.
 */
export const ALSHROUQ_TONE_STYLES: Record<AlShrouqTone, AlShrouqToneStyle> = {
  muted: {
    badge: "bg-muted text-muted-foreground",
    band: "border-border/60 bg-muted/20 text-muted-foreground dark:bg-muted/10",
    icon: "text-muted-foreground",
  },
  info: {
    badge: "bg-primary/10 text-primary",
    band: "border-primary/25 bg-primary/5 text-foreground",
    icon: "text-primary",
  },
  success: {
    badge: "bg-success/10 text-success",
    band: "border-success/25 bg-success/5 text-foreground",
    icon: "text-success",
  },
  warning: {
    badge: "bg-warning/10 text-warning",
    band: "border-warning/30 bg-warning/5 text-foreground",
    icon: "text-warning",
  },
  danger: {
    badge: "bg-destructive/10 text-destructive",
    band: "border-destructive/30 bg-destructive/5 text-foreground",
    icon: "text-destructive",
  },
};

export function alshrouqToneStyle(tone: AlShrouqTone): AlShrouqToneStyle {
  return ALSHROUQ_TONE_STYLES[tone] ?? ALSHROUQ_TONE_STYLES.muted;
}

/**
 * What the state means, in one sentence an agent can act on.
 *
 * Each says what has happened *to a courier* — contacted or not — because that
 * is the only fact that changes what the agent should do next. None of them
 * names a table, a status value or a mechanism: an agent should not have to
 * learn this system's internals to read its screen.
 */
export function explainAlShrouqState(summary: AlShrouqDispatchSummary): string {
  if (summary.status === null) return "No AlShrouq delivery has been arranged for this order yet.";
  if (summary.status === "cancelled")
    return "The delivery was called off before it was sent. No courier was contacted.";

  switch (summary.status) {
    case "scheduled":
      return "Approved and waiting for its delivery time. AlShrouq has not been contacted yet.";
    case "processing":
      return "The delivery is being handed to AlShrouq right now.";
    case "accepted":
      return "AlShrouq has accepted this delivery and is handling it.";
    case "failed":
      return "AlShrouq did not accept this delivery, so nothing is on its way.";
    case "indeterminate":
      return "It is not known whether AlShrouq received this delivery. It has not been sent again.";
    default:
      // A state this build does not recognise. It is reported, not guessed at.
      return "A delivery record exists for this order, so it cannot be sent again.";
  }
}

/**
 * The step an agent is on, for a card that has not been approved yet.
 *
 * Separate from `explainAlShrouqState` because these are not dispatch states —
 * there is no dispatch. They are the reasons the send control is or is not
 * available, said as a next action rather than as a status.
 */
export type AlShrouqReadiness = "draft" | "checking" | "ready" | "unverified" | "unavailable";

export function explainAlShrouqReadiness(readiness: AlShrouqReadiness): string {
  switch (readiness) {
    case "draft":
      return "Create the order first. You can choose to send it to AlShrouq as you create it.";
    case "checking":
      return "Checking whether this branch can be delivered by AlShrouq.";
    case "ready":
      return "This order can be handed to AlShrouq. You will confirm the details before anything is sent.";
    case "unverified":
      return "Branch coverage could not be checked, so this order cannot be handed over yet.";
    case "unavailable":
      return "This order cannot be delivered by AlShrouq.";
  }
}

/**
 * What pressing the primary button will actually do.
 *
 * Written out because the two create choices are genuinely different outcomes
 * and the button labels alone have to be short. "Send" reads as *sent* to
 * somebody in a hurry, and on the scheduled path nothing is sent at all — so
 * the scheduled wording never uses the word without saying when.
 */
export function describeApprovalAction(
  mode: "create" | "existing",
  intent: "order_only" | "dispatch",
  scheduledLabel: string | null,
): string {
  if (intent === "order_only") {
    return "Saves the order in MilaPortal only. AlShrouq is not contacted, and you can hand it over later from the order page.";
  }
  if (scheduledLabel) {
    return mode === "create"
      ? `Saves the order and reserves the delivery for ${scheduledLabel}. No courier is contacted now.`
      : `Reserves the delivery for ${scheduledLabel}. No courier is contacted now.`;
  }
  return mode === "create"
    ? "Saves the order and hands it to AlShrouq straight away."
    : "Hands this order to AlShrouq straight away.";
}
