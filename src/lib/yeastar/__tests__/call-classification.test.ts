/**
 * Call classification — the shared Missed / Abandoned rules.
 *
 * The correctness boundary here is agreement: a KPI card, a chart, a table and
 * a drill-down all pass through these functions, so a card reading "Missed 0"
 * must be unable to open onto a list of missed calls. These pin both halves of
 * that — which system's split is in force, and how its COUNTS become per-call
 * LABELS without inventing, dropping or duplicating a call.
 */
import { describe, expect, it } from "vitest";
import {
  classifyUnansweredCalls,
  isQueueSplitApplicable,
  isUnansweredQueueCall,
  resolveQueueOutcomeSplit,
  resolveQueueOutcomes,
} from "../call-classification";
import type { NormalizedCall } from "../normalize";

/** A normalized call with only the fields the classifier reads set. */
function call(over: Partial<NormalizedCall> & { callId: string }): NormalizedCall {
  return {
    direction: "Inbound",
    declaredDirection: "Inbound",
    directionCorrected: false,
    startedAt: 1_000,
    callerNumber: "0501234567",
    calleeNumber: "",
    didNumber: null,
    queueNumber: "6400",
    answeringExtension: null,
    answeredByAgent: false,
    reachedQueue: true,
    outcome: "missed",
    queueWaitSeconds: 10,
    agentRingSeconds: null,
    talkSeconds: 0,
    exclusion: null,
    operational: true,
    legs: [],
    ...over,
  };
}

describe("resolveQueueOutcomeSplit", () => {
  const cdr = { missed: 95, abandoned: 2 };

  it("prefers the PBX whenever it has an opinion", () => {
    expect(resolveQueueOutcomeSplit(cdr, { missedCalls: 1, abandonedCalls: 96 }, "cdr")).toEqual({
      missed: 1,
      abandoned: 96,
      source: "call_report",
    });
  });

  it("passes CDR through, carrying CDR's own availability", () => {
    expect(resolveQueueOutcomeSplit(cdr, null, "cdr")).toEqual({
      missed: 95,
      abandoned: 2,
      source: "cdr",
    });
    expect(resolveQueueOutcomeSplit(cdr, null, "unavailable").source).toBe("unavailable");
  });

  it("takes an all-zero report at face value — a quiet queue is a real answer", () => {
    expect(resolveQueueOutcomeSplit(cdr, { missedCalls: 0, abandonedCalls: 0 }, "cdr")).toEqual({
      missed: 0,
      abandoned: 0,
      source: "call_report",
    });
  });
});

describe("isQueueSplitApplicable", () => {
  it("needs a report to be there at all", () => {
    expect(isQueueSplitApplicable({ direction: "all", agentId: "all" }, false)).toBe(false);
  });

  it("applies to the unfiltered and the inbound-filtered view", () => {
    expect(isQueueSplitApplicable({ direction: "all", agentId: "all" }, true)).toBe(true);
    expect(isQueueSplitApplicable({ direction: "Inbound", agentId: "all" }, true)).toBe(true);
  });

  it("refuses an outbound view — the report describes inbound queue calls", () => {
    expect(isQueueSplitApplicable({ direction: "Outbound", agentId: "all" }, true)).toBe(false);
  });

  it("refuses a single-agent view — the report counts the whole queue", () => {
    // This is what would otherwise render a queue-wide number over one agent's
    // calls, which no drill-down could ever match.
    expect(isQueueSplitApplicable({ direction: "all", agentId: "agent-1" }, true)).toBe(false);
  });
});

describe("resolveQueueOutcomes", () => {
  it("rates the RENDERED split, not CDR's, so a card and its rate agree", () => {
    const view = resolveQueueOutcomes(
      { missed: 95, abandoned: 2, inbound: 200 },
      { missedCalls: 1, abandonedCalls: 96 },
      "cdr",
    );
    expect(view.missed).toBe(1);
    expect(view.missedRate).toBeCloseTo(0.5);
    expect(view.abandonRate).toBeCloseTo(48);
    // The population stays CDR's, so it still ties out against queue calls.
    expect(view.unansweredTotal).toBe(97);
  });

  it("reports zero rates rather than dividing by an empty window", () => {
    const view = resolveQueueOutcomes({ missed: 0, abandoned: 0, inbound: 0 }, null, "cdr");
    expect(view.missedRate).toBe(0);
    expect(view.abandonRate).toBe(0);
  });
});

describe("classifyUnansweredCalls", () => {
  it("covers exactly the unanswered queue calls", () => {
    expect(isUnansweredQueueCall(call({ callId: "a", outcome: "abandoned" }))).toBe(true);
    expect(isUnansweredQueueCall(call({ callId: "m", outcome: "missed" }))).toBe(true);
    expect(isUnansweredQueueCall(call({ callId: "x", outcome: "answered" }))).toBe(false);
    expect(isUnansweredQueueCall(call({ callId: "i", outcome: "ivr_only" }))).toBe(false);

    const labels = classifyUnansweredCalls(
      [
        call({ callId: "a", outcome: "abandoned" }),
        call({ callId: "x", outcome: "answered" }),
        call({ callId: "i", outcome: "ivr_only" }),
      ],
      { abandoned: 0, source: "cdr" },
    );
    expect([...labels.keys()]).toEqual(["a"]);
  });

  it("passes CDR's own labels straight through", () => {
    const labels = classifyUnansweredCalls(
      [
        call({ callId: "a", outcome: "abandoned", queueWaitSeconds: 2 }),
        call({ callId: "m", outcome: "missed", queueWaitSeconds: 40 }),
      ],
      // `abandoned` is ignored entirely while the source is CDR.
      { abandoned: 99, source: "cdr" },
    );
    expect(labels.get("a")).toBe("abandoned");
    expect(labels.get("m")).toBe("missed");
  });

  it("re-cuts the population at the PBX's boundary, shortest wait first", () => {
    // CDR labels all three missed. The PBX says two callers hung up, so the two
    // shortest waits become abandoned and the longest stays the queue's release.
    const labels = classifyUnansweredCalls(
      [
        call({ callId: "long", outcome: "missed", queueWaitSeconds: 60 }),
        call({ callId: "short", outcome: "missed", queueWaitSeconds: 8 }),
        call({ callId: "mid", outcome: "missed", queueWaitSeconds: 20 }),
      ],
      { abandoned: 2, source: "call_report" },
    );
    expect(labels.get("short")).toBe("abandoned");
    expect(labels.get("mid")).toBe("abandoned");
    expect(labels.get("long")).toBe("missed");
  });

  it("never invents, drops or duplicates a call when the counts disagree", () => {
    // The PBX counted more unanswered calls than this window holds. Everything
    // present is labelled; nothing is fabricated to make up the difference.
    const window = [
      call({ callId: "u1", outcome: "abandoned", queueWaitSeconds: 3 }),
      call({ callId: "u2", outcome: "missed", queueWaitSeconds: 30 }),
    ];
    const over = classifyUnansweredCalls(window, { abandoned: 50, source: "call_report" });
    expect(over.size).toBe(2);
    expect([...over.values()]).toEqual(["abandoned", "abandoned"]);

    // And the other way: the surplus falls to missed.
    const under = classifyUnansweredCalls(window, { abandoned: 0, source: "call_report" });
    expect([...under.values()]).toEqual(["missed", "missed"]);
  });

  it("labels the same window the same way every time", () => {
    // A list that reshuffled between refreshes would be useless for follow-up,
    // so equal waits break on time and then on id rather than on input order.
    const window = [
      call({ callId: "b", startedAt: 2_000, outcome: "missed", queueWaitSeconds: 10 }),
      call({ callId: "a", startedAt: 2_000, outcome: "missed", queueWaitSeconds: 10 }),
    ];
    const split = { abandoned: 1, source: "call_report" } as const;
    const first = classifyUnansweredCalls(window, split);
    const second = classifyUnansweredCalls([...window].reverse(), split);
    expect(first.get("a")).toBe("abandoned");
    expect(second.get("a")).toBe("abandoned");
  });
});
