/**
 * Reading and writing the Control Center's configuration. Server-only.
 *
 * Two tables, both tiny: one global switch and a handful of daily slots. This
 * module is the only place either is written, so every change goes past the same
 * validation and every write is attributable.
 *
 * ## Why validation lives here and not only in the UI
 *
 * A slot's `local_time` decides when a full catalogue refresh hits a third-party
 * production system. A browser is not the right place to be the last word on
 * that, so the shapes are re-checked server-side even though the form already
 * constrains them.
 */

import { nextOccurrence, parseLocalTime, type ScheduleSlot } from "./sync-schedule";

interface SupabaseLike {
  from: (table: string) => any;
}

const SETTINGS = "shams_sync_settings";
const SLOTS = "shams_sync_schedule_slots";

/**
 * How many slots one deployment may hold.
 *
 * Twenty-four, because a slot is a *daily wall-clock time* and the minute-level
 * tick resolves each one independently: twenty-four is one per hour, which is
 * the point past which a set of named daily times stops being a timetable and
 * becomes an interval schedule — something this model deliberately does not try
 * to be. It is not a performance ceiling. Each slot costs one indexed row in a
 * query the tick already runs, and an administrator would have to be doing
 * something quite unusual to reach it.
 *
 * The reason a bound exists at all is upstream, not local: every occurrence is a
 * full catalogue refresh costing Shams roughly 840 page fetches, so a mis-click
 * that turned into a runaway number of daily rows should hit something. Raise it
 * freely if a real timetable ever needs more.
 */
export const MAX_SLOTS = 24;

/** The zone the Control Center works in. Slots may carry others; none do today. */
export const DEFAULT_TIME_ZONE = "Asia/Riyadh";

export interface ShamsSyncSettings {
  automationEnabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ScheduleSlotRecord extends ScheduleSlot {
  lastScheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

function toSlot(row: Record<string, any>): ScheduleSlotRecord {
  return {
    id: row.id,
    enabled: row.enabled === true,
    // Postgres renders `time` as `HH:MM:SS`; the pure module accepts both forms.
    localTime: String(row.local_time ?? "").slice(0, 5),
    timeZone: row.time_zone ?? DEFAULT_TIME_ZONE,
    syncStock: row.sync_stock === true,
    syncPromotions: row.sync_promotions === true,
    nextDueAt: row.next_due_at ?? null,
    lastScheduledFor: row.last_scheduled_for ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function readSyncSettings(supabase: SupabaseLike): Promise<ShamsSyncSettings> {
  const { data } = await supabase.from(SETTINGS).select("*").eq("id", 1).maybeSingle();
  const row = (data ?? null) as Record<string, any> | null;
  return {
    // Absent row reads as OFF. The safe direction: a missing configuration must
    // never be interpreted as permission to run.
    automationEnabled: row?.automation_enabled === true,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** Slots in display order: by time of day, so the table reads like a timetable. */
export async function readScheduleSlots(supabase: SupabaseLike): Promise<ScheduleSlotRecord[]> {
  const { data } = await supabase.from(SLOTS).select("*").order("local_time", { ascending: true });
  return ((data ?? []) as Record<string, any>[]).map(toSlot);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export interface SlotInput {
  id?: string | null;
  localTime: string;
  syncStock: boolean;
  syncPromotions: boolean;
  enabled: boolean;
}

export type SlotValidation = { ok: true; localTime: string } | { ok: false; message: string };

/**
 * Check a slot an administrator submitted.
 *
 * The one rule worth stating: a slot must target something. A row with both
 * kinds off would sit in the timetable looking scheduled while doing nothing —
 * the administrator means "disable this slot", and should be told to say so.
 */
export function validateSlot(input: SlotInput): SlotValidation {
  const time = parseLocalTime(input.localTime);
  if (!time) {
    return { ok: false, message: "Enter a valid time of day." };
  }
  if (!input.syncStock && !input.syncPromotions) {
    return {
      ok: false,
      message: "A schedule must update Stock, Promotions, or both. To stop it running, disable it.",
    };
  }
  const localTime = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
  return { ok: true, localTime };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export async function setAutomationEnabled(
  supabase: SupabaseLike,
  enabled: boolean,
  actorId: string,
): Promise<void> {
  await supabase
    .from(SETTINGS)
    .update({
      automation_enabled: enabled,
      updated_at: new Date().toISOString(),
      updated_by: actorId,
    })
    .eq("id", 1);
}

export type SlotWriteResult =
  | { kind: "saved"; slot: ScheduleSlotRecord }
  | { kind: "invalid"; message: string }
  | { kind: "limit"; message: string }
  | { kind: "not_found" };

/**
 * Create or update one slot.
 *
 * `next_due_at` is recomputed on every write, so the time the Control Center
 * displays is the same value the scheduler will act on. Letting the two be
 * calculated separately is how a UI ends up promising a run that never happens.
 *
 * Recomputing also means moving a slot's time cancels its pending occurrence
 * rather than leaving the old one armed — which is what an administrator means
 * when they change 15:00 to 14:00.
 */
export async function upsertScheduleSlot(
  supabase: SupabaseLike,
  input: SlotInput,
  actorId: string,
  now: Date = new Date(),
): Promise<SlotWriteResult> {
  const checked = validateSlot(input);
  if (!checked.ok) return { kind: "invalid", message: checked.message };

  const draft: ScheduleSlot = {
    id: input.id ?? "draft",
    enabled: input.enabled,
    localTime: checked.localTime,
    timeZone: DEFAULT_TIME_ZONE,
    syncStock: input.syncStock,
    syncPromotions: input.syncPromotions,
    nextDueAt: null,
  };
  const nextDue = nextOccurrence(draft, now);

  const payload = {
    enabled: input.enabled,
    local_time: checked.localTime,
    time_zone: DEFAULT_TIME_ZONE,
    sync_stock: input.syncStock,
    sync_promotions: input.syncPromotions,
    next_due_at: nextDue ? nextDue.toISOString() : null,
    updated_at: now.toISOString(),
    updated_by: actorId,
  };

  if (input.id) {
    const { data } = await supabase
      .from(SLOTS)
      .update(payload)
      .eq("id", input.id)
      .select("*")
      .maybeSingle();
    if (!data) return { kind: "not_found" };
    return { kind: "saved", slot: toSlot(data as Record<string, any>) };
  }

  const existing = await readScheduleSlots(supabase);
  if (existing.length >= MAX_SLOTS) {
    return {
      kind: "limit",
      message: `A maximum of ${MAX_SLOTS} schedules is allowed. Remove one before adding another.`,
    };
  }

  const { data } = await supabase.from(SLOTS).insert(payload).select("*").single();
  if (!data) return { kind: "not_found" };
  return { kind: "saved", slot: toSlot(data as Record<string, any>) };
}

export async function deleteScheduleSlot(supabase: SupabaseLike, id: string): Promise<boolean> {
  const { data } = await supabase.from(SLOTS).delete().eq("id", id).select("id").maybeSingle();
  return Boolean(data);
}

/**
 * Move a slot on to its next occurrence.
 *
 * Called after an occurrence is acted on, whether it ran or was recorded as
 * missed. `last_scheduled_for` keeps the occurrence we handled, so the history
 * and the schedule agree about what happened.
 */
export async function advanceSlot(
  supabase: SupabaseLike,
  slotId: string,
  handledOccurrence: Date | null,
  nextDueAt: Date | null,
  now: Date = new Date(),
): Promise<void> {
  await supabase
    .from(SLOTS)
    .update({
      next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
      last_scheduled_for: handledOccurrence ? handledOccurrence.toISOString() : undefined,
      updated_at: now.toISOString(),
    })
    .eq("id", slotId);
}
