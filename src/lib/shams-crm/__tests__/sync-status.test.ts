/**
 * The judgement calls in the Shams sync integration, asserted directly.
 *
 * Two of these matter more than the rest:
 *
 *   1. **The timestamp correction fires on the broken endpoint and not on the
 *      healthy one.** It is inferred at runtime from a contradiction rather than
 *      configured per sync type, so the only way to know it discriminates
 *      correctly is to run both real payloads through it.
 *
 *   2. **`classifyRun` never invents an outcome.** A run the CRM can no longer
 *      account for must come back `lost` — never `success`, never `failed` —
 *      because both would be fabrications written into a history an
 *      administrator uses to judge whether the integration is working.
 *
 * The fixtures below are the genuine responses captured from the PharmacyCRM
 * Desktop's local cache during the Phase 1 investigation, reproduced verbatim.
 * They contain no credentials: the status endpoints return run metadata only.
 */

import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  assessTimestamp,
  classifyRun,
  normalizeSyncStatus,
  parseCrmTimestamp,
  parseSyncNotes,
  readTriggerRunId,
  type RawShamsSyncStatus,
} from "@/lib/shams-crm/sync-status";

/* -------------------------------------------------------------------------- */
/* Fixtures — verbatim Phase 1 captures                                        */
/* -------------------------------------------------------------------------- */

/** `GET /stock/sync/status`, run 347. Timestamps are genuinely UTC. */
const STOCK_STATUS: RawShamsSyncStatus = {
  latest_run: {
    id: 347,
    sync_type: "full",
    status: "success",
    started_at: "2026-08-27T17:24:37.296235",
    completed_at: "2026-08-27T17:49:01.539894",
    pages_fetched: 839,
    rows_seen: 772594,
    rows_changed: 9970,
    notes:
      "itm_cd= wh_cd= worker_pid=1831399 completed_at=2026-08-27T17:49:01.539894 " +
      "status=success max_pages=20000 sync_mode=branch_by_branch",
  },
  active_run: null,
  last_success_at_utc: "2026-08-27T17:49:01.539894",
  last_success_at_riyadh: "2026-08-27T20:49:01.539894",
  next_scheduled_sync_at_utc: null,
  next_scheduled_sync_at_riyadh: null,
  sync_interval_minutes: 0,
  is_running: false,
};

/**
 * `GET /promotions/sync/status`, run 75.
 *
 * These timestamps are Riyadh local sitting in fields labelled UTC. The proof is
 * the ordering: this very response was cached by the Desktop at 18:27:13 UTC
 * while claiming a run that started at 20:24:31.
 */
const PROMO_STATUS: RawShamsSyncStatus = {
  latest_run: {
    id: 75,
    sync_type: "full",
    status: "success",
    started_at: "2026-08-27T20:24:31.011750",
    completed_at: "2026-08-27T20:51:00.762628",
    pages_fetched: 138,
    rows_seen: 10970,
    rows_changed: 414,
    notes:
      "docno_mode=sequential branch_code= vendor=cash " +
      "completed_at=2026-08-27T20:51:00.762628 status=success " +
      "branches_targeted=138 branches_seen=138",
  },
  active_run: null,
  last_success_at_utc: "2026-08-27T20:51:00.762628",
  last_success_at_riyadh: "2026-08-27T23:51:00.762628",
  next_scheduled_sync_at_utc: null,
  sync_interval_minutes: 0,
  is_running: false,
};

/** The moment the Desktop actually read both endpoints: 18:27:13 UTC. */
const OBSERVED_AT = Date.parse("2026-08-27T18:27:13Z");

/* -------------------------------------------------------------------------- */

describe("parseCrmTimestamp", () => {
  it("reads a naive timestamp as UTC, not as the host's local time", () => {
    // The trap: `new Date("2026-08-27T17:49:01")` is local-time in JS, so this
    // would drift by the runner's offset if the anchoring were left implicit.
    expect(parseCrmTimestamp("2026-08-27T17:49:01.539894")).toBe(
      Date.parse("2026-08-27T17:49:01.539Z"),
    );
  });

  it("truncates six-digit fractional seconds rather than trusting the parser", () => {
    expect(parseCrmTimestamp("2026-08-27T17:49:01.539894")).toBe(
      parseCrmTimestamp("2026-08-27T17:49:01.539"),
    );
  });

  it("respects an explicit zone when one is given", () => {
    expect(parseCrmTimestamp("2026-08-27T20:49:01+03:00")).toBe(Date.parse("2026-08-27T17:49:01Z"));
  });

  it("returns null for absent or unparseable values", () => {
    for (const bad of [null, undefined, "", "   ", "not a date"]) {
      expect(parseCrmTimestamp(bad)).toBeNull();
    }
  });
});

describe("assessTimestamp", () => {
  it("leaves a plainly-past UTC timestamp alone", () => {
    const seen = assessTimestamp("2026-08-27T17:49:01.539894", OBSERVED_AT);
    expect(seen.correctedFromRiyadh).toBe(false);
    expect(seen.unexplainedFuture).toBe(false);
    expect(seen.iso).toBe("2026-08-27T17:49:01.539Z");
  });

  it("corrects a timestamp that could only be Riyadh local", () => {
    const seen = assessTimestamp("2026-08-27T20:51:00.762628", OBSERVED_AT);
    expect(seen.correctedFromRiyadh).toBe(true);
    expect(seen.iso).toBe("2026-08-27T17:51:00.762Z");
    // The raw value survives untouched for the admin page to show beside it.
    expect(seen.raw).toBe("2026-08-27T20:51:00.762628");
  });

  it("tolerates ordinary clock skew without reclassifying anything", () => {
    const slightlyAhead = new Date(OBSERVED_AT + CLOCK_SKEW_TOLERANCE_MS - 1_000).toISOString();
    const seen = assessTimestamp(slightlyAhead.replace("Z", ""), OBSERVED_AT);
    expect(seen.correctedFromRiyadh).toBe(false);
    expect(seen.unexplainedFuture).toBe(false);
  });

  it("refuses to guess when the Riyadh offset does not explain the future", () => {
    // A day ahead. Shifting by three hours does not rescue it, so nothing is
    // rewritten — the value is reported exactly as sent and flagged.
    const seen = assessTimestamp("2026-08-28T18:00:00", OBSERVED_AT);
    expect(seen.correctedFromRiyadh).toBe(false);
    expect(seen.unexplainedFuture).toBe(true);
    expect(seen.iso).toBe("2026-08-28T18:00:00.000Z");
  });

  it("stops correcting once the source is fixed", () => {
    /*
     * The self-removal property. Read a whole day later, the promotions
     * timestamp is comfortably in the past and is believed as UTC — which is
     * exactly what will happen every day once Shams stops mislabelling it, with
     * nobody deploying anything.
     */
    const nextDay = Date.parse("2026-08-28T18:27:13Z");
    const seen = assessTimestamp("2026-08-27T20:51:00.762628", nextDay);
    expect(seen.correctedFromRiyadh).toBe(false);
    expect(seen.iso).toBe("2026-08-27T20:51:00.762Z");
  });
});

describe("parseSyncNotes", () => {
  it("reads the stock notes, keeping empty values", () => {
    const notes = parseSyncNotes(STOCK_STATUS.latest_run!.notes);
    // `itm_cd=` is how an unfiltered run reports that it filtered on nothing.
    expect(notes.itm_cd).toBe("");
    expect(notes.wh_cd).toBe("");
    expect(notes.max_pages).toBe("20000");
    expect(notes.sync_mode).toBe("branch_by_branch");
  });

  it("reads the promotions notes", () => {
    const notes = parseSyncNotes(PROMO_STATUS.latest_run!.notes);
    expect(notes.docno_mode).toBe("sequential");
    expect(notes.vendor).toBe("cash");
    expect(notes.branches_seen).toBe("138");
    expect(notes.branches_targeted).toBe("138");
  });

  it("survives absent or malformed notes", () => {
    expect(parseSyncNotes(null)).toEqual({});
    expect(parseSyncNotes("   ")).toEqual({});
    expect(parseSyncNotes("=novalue bare")).toEqual({});
  });
});

describe("normalizeSyncStatus — the two real endpoints", () => {
  it("reports stock without correcting anything", () => {
    const status = normalizeSyncStatus(STOCK_STATUS, OBSERVED_AT);

    expect(status.timestampsCorrected).toBe(false);
    expect(status.timestampsUnexplained).toBe(false);
    expect(status.isRunning).toBe(false);
    expect(status.latestRun?.runId).toBe("347");
    expect(status.latestRun?.rowsSeen).toBe(772594);
    expect(status.latestRun?.rowsChanged).toBe(9970);
    expect(status.latestRun?.pagesFetched).toBe(839);
    // 17:24:37 -> 17:49:01 is 24m 24s. The figure the Phase 1 report quoted.
    expect(status.latestRun?.durationSeconds).toBe(1464);
    // Shams's own scheduler: present in the contract, switched off.
    expect(status.syncIntervalMinutes).toBe(0);
  });

  it("reports promotions, corrects its clock, and keeps the duration right", () => {
    const status = normalizeSyncStatus(PROMO_STATUS, OBSERVED_AT);

    expect(status.timestampsCorrected).toBe(true);
    expect(status.timestampsUnexplained).toBe(false);
    expect(status.lastSuccessAt).toBe("2026-08-27T17:51:00.762Z");
    expect(status.lastSuccessAtRaw).toBe("2026-08-27T20:51:00.762628");

    /*
     * The correction is applied to both ends of the run, so the duration is
     * unaffected by it: 26m 30s either way. A correction that shifted one end
     * only would silently corrupt every duration on the page.
     */
    expect(status.latestRun?.durationSeconds).toBe(1590);
    expect(status.latestRun?.branchesSeen).toBe(138);
    expect(status.latestRun?.branchesTargeted).toBe(138);
  });

  it("treats an active run as running even if the flag disagrees", () => {
    const status = normalizeSyncStatus(
      { ...STOCK_STATUS, is_running: false, active_run: { id: 348, status: "running" } },
      OBSERVED_AT,
    );
    // The guard is deliberately pessimistic: either signal holds the trigger.
    expect(status.isRunning).toBe(true);
  });

  it("degrades to nulls rather than throwing on an unrecognisable payload", () => {
    for (const junk of [null, undefined, {}, { latest_run: "nonsense" }]) {
      const status = normalizeSyncStatus(junk as never, OBSERVED_AT);
      expect(status.isRunning).toBe(false);
      expect(status.latestRun).toBeNull();
    }
  });

  it("withholds a duration it cannot compute rather than showing a negative one", () => {
    const status = normalizeSyncStatus(
      {
        latest_run: {
          id: 9,
          status: "success",
          started_at: "2026-08-27T17:49:01",
          completed_at: "2026-08-27T17:24:37",
        },
      },
      OBSERVED_AT,
    );
    expect(status.latestRun?.durationSeconds).toBeNull();
  });
});

describe("classifyRun", () => {
  const running = normalizeSyncStatus(
    { is_running: true, active_run: { id: 400, status: "running" } },
    OBSERVED_AT,
  );

  it("recognises our own run still in progress", () => {
    expect(classifyRun("400", running).kind).toBe("running");
  });

  it("treats an unidentified active run as ours when we hold the only claim", () => {
    const anonymous = normalizeSyncStatus({ is_running: true }, OBSERVED_AT);
    expect(classifyRun("400", anonymous).kind).toBe("running");
  });

  it("closes a finished run the CRM reports as successful", () => {
    const seen = classifyRun("347", normalizeSyncStatus(STOCK_STATUS, OBSERVED_AT));
    expect(seen).toMatchObject({ kind: "terminal", outcome: "success" });
  });

  it("treats any non-success outcome as a failure, including an unknown one", () => {
    for (const status of ["failed", "error", "cancelled", "something new"]) {
      const seen = classifyRun(
        "347",
        normalizeSyncStatus({ latest_run: { ...STOCK_STATUS.latest_run, status } }, OBSERVED_AT),
      );
      // Never optimistic about a word it does not recognise.
      expect(seen).toMatchObject({ kind: "terminal", outcome: "failed" });
    }
  });

  it("reports a run the CRM has moved past as lost, not as success", () => {
    // Our run was 340; the CRM's latest is 347. Ours is unrecoverable.
    const seen = classifyRun("340", normalizeSyncStatus(STOCK_STATUS, OBSERVED_AT));
    expect(seen.kind).toBe("lost");
  });

  it("reports a different run being active as lost", () => {
    expect(classifyRun("399", running).kind).toBe("lost");
  });

  it("never claims a run when we never learned its id", () => {
    const seen = classifyRun(null, normalizeSyncStatus(STOCK_STATUS, OBSERVED_AT));
    expect(seen.kind).toBe("lost");
  });
});

describe("readTriggerRunId", () => {
  it("accepts a numeric or string run id", () => {
    expect(readTriggerRunId({ run_id: 348 })).toBe("348");
    expect(readTriggerRunId({ run_id: "348" })).toBe("348");
  });

  it("returns null when the CRM accepted without naming a run", () => {
    // Not success: a run we cannot name is one we cannot reconcile.
    for (const body of [null, undefined, {}, { run_id: null }, { run_id: "" }]) {
      expect(readTriggerRunId(body as never)).toBeNull();
    }
  });
});
