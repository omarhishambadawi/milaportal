/**
 * How long until a scheduled AlShrouq dispatch — for display, and only display.
 *
 * ## This hook cannot dispatch anything
 *
 * It has no network call, no mutation and no server function; the only effect it
 * owns is a `setInterval` that re-renders. Reaching zero changes a label and
 * nothing else. The courier is sent by `pg_cron` → the worker → the safety gate,
 * which is why a closed laptop, a logged-out agent or a sleeping tab makes no
 * difference to whether the delivery happens.
 *
 * That separation is the point. A countdown that fired the request would mean
 * two open tabs sending two couriers, and a closed one sending none.
 *
 * ## Reconstructed, never remembered
 *
 * The target comes from the persisted `scheduled_for` on every render, so a
 * refresh, a different browser or a different device all show the same figure —
 * there is no local state to lose or to disagree with the row.
 *
 * ## It stops claiming things it cannot know
 *
 * Once the row leaves `scheduled` — a worker has claimed it, or it has been sent
 * — the countdown is over regardless of the clock, because a number ticking down
 * beside an order already on its way is a lie. Pass the row's `status` and the
 * hook reports `state: "inactive"`.
 */

import { useEffect, useMemo, useState } from "react";
import { describeRemaining, formatScheduledFor } from "./scheduling";

/** The lifecycle values that mean "still waiting for its time". */
const WAITING = "scheduled";

export interface ScheduledCountdown {
  /**
   * `waiting` — still ahead; `due` — the moment has passed and the worker will
   * take it on its next tick; `inactive` — nothing scheduled, or no longer
   * waiting.
   */
  state: "waiting" | "due" | "inactive";
  /** Milliseconds left, floored at zero. Null when inactive. */
  remainingMs: number | null;
  /** "2 hours 3 minutes". Null when inactive. */
  remainingLabel: string | null;
  /** "Aug 21, 2026 · 03:30 PM", in Riyadh. Null when nothing is scheduled. */
  scheduledLabel: string | null;
}

const INACTIVE: ScheduledCountdown = {
  state: "inactive",
  remainingMs: null,
  remainingLabel: null,
  scheduledLabel: null,
};

/**
 * Compute the countdown for one instant. Pure — the hook is a clock on top.
 *
 * Exported so the behaviour can be tested without rendering or faking timers:
 * every rule that matters here is a function of two timestamps and a status.
 */
export function scheduledCountdownAt(
  scheduledFor: string | null | undefined,
  dispatchStatus: string | null | undefined,
  now: number,
): ScheduledCountdown {
  if (!scheduledFor) return INACTIVE;

  const target = Date.parse(scheduledFor);
  if (Number.isNaN(target)) return INACTIVE;

  const scheduledLabel = formatScheduledFor(scheduledFor);

  // A claimed or finished dispatch is not counting down to anything.
  if (dispatchStatus != null && dispatchStatus !== WAITING) {
    return { ...INACTIVE, scheduledLabel };
  }

  const remainingMs = Math.max(0, target - now);
  if (remainingMs === 0) {
    return { state: "due", remainingMs: 0, remainingLabel: null, scheduledLabel };
  }

  return {
    state: "waiting",
    remainingMs,
    remainingLabel: describeRemaining(remainingMs),
    scheduledLabel,
  };
}

/**
 * A live countdown to a persisted `scheduled_for`.
 *
 * Ticks once a second while something is actually waiting, and not at all
 * otherwise — an order page with no scheduled dispatch installs no timer.
 */
export function useScheduledDispatchCountdown(
  scheduledFor: string | null | undefined,
  dispatchStatus?: string | null,
): ScheduledCountdown {
  const [now, setNow] = useState(() => Date.now());

  const active = !!scheduledFor && (dispatchStatus == null || dispatchStatus === WAITING);

  useEffect(() => {
    if (!active) return;
    // Re-read the clock rather than adding 1000: a sleeping tab does not get its
    // intervals, and an accumulated counter would wake up wrong.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, scheduledFor, dispatchStatus]);

  return useMemo(
    () => scheduledCountdownAt(scheduledFor, dispatchStatus, now),
    [scheduledFor, dispatchStatus, now],
  );
}
