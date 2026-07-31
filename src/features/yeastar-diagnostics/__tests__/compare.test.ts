import { describe, expect, it } from "vitest";
import {
  buildComparison,
  expectedOfficialClassification,
  filterCallRows,
  inspectMismatch,
  parseDuration,
  EMPTY_CALL_FILTERS,
  EMPTY_OFFICIAL,
  type CallRow,
} from "../compare";

/**
 * The reference case throughout is 30/07/2026, Yeastar Reports > Extension Call
 * Statistics:
 *
 *   Official  Total 158 · Answered 100 · No Answer 29 · Busy 15 · Failed 0
 *             Talk 02:40:31
 *   Dashboard Total 157 · Answered  99 · No Answer 43 · Busy 15 · Failed 0
 *             Talk 02:23:35
 */
const DASHBOARD = {
  total: 157,
  answered: 99,
  noAnswerOutbound: 43,
  busy: 15,
  failed: 0,
  inbound: 0,
  outbound: 157,
  talkSeconds: 8615, // 02:23:35
  avgTalkSec: 8615 / 99,
  answerRate: (99 / 157) * 100,
};

const OFFICIAL = {
  ...EMPTY_OFFICIAL,
  total: "158",
  answered: "100",
  noAnswer: "29",
  busy: "15",
  failed: "0",
  inbound: "0",
  outbound: "158",
  talkTime: "02:40:31",
};

const byKey = (rows: ReturnType<typeof buildComparison>) =>
  Object.fromEntries(rows.map((r) => [r.key, r]));

describe("parseDuration", () => {
  it("reads the hh:mm:ss the Yeastar report prints", () => {
    expect(parseDuration("02:40:31")).toBe(9631);
    expect(parseDuration("00:00:00")).toBe(0);
  });

  it("accepts mm:ss and bare seconds", () => {
    expect(parseDuration("16:56")).toBe(1016);
    expect(parseDuration("9631")).toBe(9631);
  });

  it("returns null rather than guessing at nonsense", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("  ")).toBeNull();
    expect(parseDuration("2h40m")).toBeNull();
    expect(parseDuration("1:2:3:4")).toBeNull();
  });
});

describe("buildComparison", () => {
  it("flags exactly the reference day's mismatches", () => {
    // The five counted KPIs that differ, plus the two derived from them:
    // answer rate 99/157 = 63.06% against 100/158 = 63.29%, and average talk
    // 87.0s against 96.3s. Both follow from the one missing call.
    const rows = buildComparison(DASHBOARD, OFFICIAL);
    const mismatched = rows.filter((r) => r.status === "mismatch").map((r) => r.key);
    expect(mismatched.sort()).toEqual(
      [
        "answerRate",
        "answered",
        "avgTalkSec",
        "noAnswer",
        "outbound",
        "talkSeconds",
        "total",
      ].sort(),
    );
  });

  it("reports the exact differences", () => {
    const k = byKey(buildComparison(DASHBOARD, OFFICIAL));
    expect(k.total.difference).toBe(-1);
    expect(k.answered.difference).toBe(-1);
    expect(k.outbound.difference).toBe(-1);
    expect(k.noAnswer.difference).toBe(14);
    expect(k.talkSeconds.difference).toBe(-1016); // 16:56
  });

  it("matches the KPIs that agree", () => {
    const k = byKey(buildComparison(DASHBOARD, OFFICIAL));
    expect(k.busy.status).toBe("match");
    expect(k.failed.status).toBe("match");
    expect(k.inbound.status).toBe("match");
  });

  it("derives average talk and answer rate from the official counts", () => {
    // The report prints these rounded, so transcribing them would manufacture a
    // mismatch out of rounding. They are computed from Total/Answered/Talk.
    const k = byKey(buildComparison(DASHBOARD, OFFICIAL));
    expect(k.avgTalkSec.official).toBeCloseTo(9631 / 100, 2);
    expect(k.answerRate.official).toBeCloseTo((100 / 158) * 100, 2);
  });

  it("marks KPIs with no official figure as not entered, never as a match", () => {
    const rows = buildComparison(DASHBOARD, EMPTY_OFFICIAL);
    expect(rows.every((r) => r.status === "not-entered")).toBe(true);
    expect(rows.every((r) => r.difference === null)).toBe(true);
  });

  it("does not report a mismatch when everything agrees", () => {
    const perfect = {
      ...DASHBOARD,
      total: 158,
      answered: 100,
      noAnswerOutbound: 29,
      outbound: 158,
      talkSeconds: 9631,
      avgTalkSec: 9631 / 100,
      answerRate: (100 / 158) * 100,
    };
    const rows = buildComparison(perfect, OFFICIAL);
    expect(rows.filter((r) => r.status === "mismatch")).toEqual([]);
  });
});

const call = (over: Partial<CallRow>): CallRow => ({
  callId: "1782844637.854",
  startedAt: 1782844637,
  direction: "Outbound",
  declaredDirection: "Outbound",
  directionCorrected: false,
  extension: "1000",
  agentName: "Ahmed Mousad",
  classification: "answered",
  included: true,
  exclusionReason: null,
  talkSeconds: 120,
  ringSeconds: 8,
  queueWaitSeconds: null,
  queueNumber: null,
  legs: 1,
  rootCause: "none",
  ...over,
});

describe("filterCallRows", () => {
  const rows = [
    call({ callId: "a.1", extension: "1000" }),
    call({ callId: "b.2", extension: "1001", classification: "cancelled_by_agent" }),
    call({
      callId: "c.3",
      extension: "4005",
      direction: "Inbound",
      included: false,
      exclusionReason: "ivr_only",
      rootCause: "ivr_only",
    }),
  ];

  it("returns everything by default", () => {
    expect(filterCallRows(rows, EMPTY_CALL_FILTERS)).toHaveLength(3);
  });

  it("finds a call by partial id, as pasted from the report", () => {
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, callId: "b." })).toHaveLength(1);
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, callId: "zzz" })).toHaveLength(0);
  });

  it("filters by extension, direction, classification and root cause", () => {
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, extension: "1001" })).toHaveLength(1);
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, direction: "Inbound" })).toHaveLength(1);
    expect(
      filterCallRows(rows, { ...EMPTY_CALL_FILTERS, classification: "cancelled_by_agent" }),
    ).toHaveLength(1);
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, rootCause: "ivr_only" })).toHaveLength(1);
  });

  it("filters by agent", () => {
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, agentId: "1000" })).toHaveLength(1);
  });

  it("separates included from excluded calls", () => {
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, includedOnly: "excluded" })).toHaveLength(
      1,
    );
    expect(filterCallRows(rows, { ...EMPTY_CALL_FILTERS, includedOnly: "included" })).toHaveLength(
      2,
    );
  });
});

describe("inspectMismatch", () => {
  it("blames the No Answer gap on agent cancellations", () => {
    const rows = [
      call({ callId: "x", classification: "cancelled_by_agent" }),
      call({ callId: "y", classification: "no_answer_outbound" }),
    ];
    const { candidates } = inspectMismatch("noAnswer", rows);
    expect(candidates.map((c) => c.callId)).toEqual(["x"]);
  });

  it("offers excluded calls as the only rows that can lower a total", () => {
    const rows = [
      call({ callId: "kept" }),
      call({ callId: "dropped", included: false, exclusionReason: "ivr_only" }),
    ];
    const { candidates } = inspectMismatch("total", rows);
    expect(candidates.map((c) => c.callId)).toEqual(["dropped"]);
  });

  it("returns nothing when no call can explain a shortfall", () => {
    // Every call is included, so a dashboard total BELOW the official one means
    // the missing calls were never received — the finding is the empty list.
    const { candidates } = inspectMismatch("total", [call({ callId: "only" })]);
    expect(candidates).toEqual([]);
  });

  it("surfaces direction corrections when Inbound disagrees", () => {
    const rows = [
      call({ callId: "moved", directionCorrected: true, declaredDirection: "Inbound" }),
      call({ callId: "plain" }),
    ];
    const { candidates } = inspectMismatch("inbound", rows);
    expect(candidates.map((c) => c.callId)).toEqual(["moved"]);
  });
});

describe("expectedOfficialClassification", () => {
  it("maps our buckets onto what the report should say", () => {
    expect(expectedOfficialClassification(call({ classification: "answered" }))).toBe("Answered");
    expect(expectedOfficialClassification(call({ classification: "no_answer_outbound" }))).toBe(
      "No Answer",
    );
    expect(expectedOfficialClassification(call({ classification: "busy" }))).toBe("Busy");
  });

  it("explains that a cancelled call is counted but not as No Answer", () => {
    expect(expectedOfficialClassification(call({ classification: "cancelled_by_agent" }))).toBe(
      "counted, not No Answer",
    );
  });

  it("says a call that never reached an extension is absent from the report", () => {
    expect(
      expectedOfficialClassification(call({ included: false, exclusionReason: "ivr_only" })),
    ).toBe("not in report");
  });

  it("says an after-hours call is still counted by the PBX, which has no such rule", () => {
    expect(
      expectedOfficialClassification(call({ included: false, exclusionReason: "after_hours" })),
    ).toBe("counted");
  });
});
