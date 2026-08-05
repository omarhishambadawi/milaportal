/**
 * Abandoned / Missed drill-down.
 *
 * The correctness boundary here is the "handled later" derivation: nothing in
 * the CDR links a caller who gave up to the callback that eventually reached
 * them, so the link is reconstructed. Getting it wrong is not a cosmetic bug —
 * it either tells a supervisor a customer was looked after when nobody rang
 * back, or sends them chasing a customer who was already called. These pin the
 * rules that make it trustworthy: same subscriber across the PBX's several
 * spellings, strictly later, first one wins, customers only.
 */
import { describe, it, expect } from "vitest";
import type { NormalizedCall } from "@/lib/yeastar/normalize";
import {
  buildFollowUpIndex,
  findFirstFollowUp,
  selectUnansweredCalls,
} from "@/lib/yeastar/unanswered";

const AGENTS = new Map([
  ["4005", { name: "Shams Rafiq", team: "customer_care" as const }],
  ["1000", { name: "Ahmed Mousad", team: "telesales" as const }],
]);

/** A normalized call with only the fields a drill-down row reads set. */
function call(partial: Partial<NormalizedCall> & { callId: string }): NormalizedCall {
  return {
    direction: "Inbound",
    declaredDirection: "Inbound",
    directionCorrected: false,
    startedAt: 1_000,
    callerNumber: "",
    calleeNumber: "",
    didNumber: null,
    queueNumber: "6400",
    answeringExtension: null,
    answeredByAgent: false,
    reachedQueue: true,
    outcome: "abandoned",
    queueWaitSeconds: 3,
    agentRingSeconds: null,
    talkSeconds: 0,
    exclusion: null,
    operational: true,
    legs: [],
    ...partial,
  };
}

const abandoned = (id: string, at: number, from = "0501234567") =>
  call({ callId: id, startedAt: at, callerNumber: from, outcome: "abandoned" });

const answeredOutbound = (id: string, at: number, to: string, ext: string) =>
  call({
    callId: id,
    startedAt: at,
    direction: "Outbound",
    declaredDirection: "Outbound",
    calleeNumber: to,
    outcome: "answered",
    answeredByAgent: false,
    answeringExtension: ext,
    reachedQueue: false,
    queueNumber: null,
    queueWaitSeconds: null,
    talkSeconds: 120,
  });

const answeredInbound = (id: string, at: number, from: string, ext: string) =>
  call({
    callId: id,
    startedAt: at,
    callerNumber: from,
    outcome: "answered",
    answeredByAgent: true,
    answeringExtension: ext,
    talkSeconds: 90,
  });

describe("findFirstFollowUp", () => {
  it("matches the same subscriber across the spellings the PBX files them under", () => {
    // The abandoned call recorded `0501234567`; the callback went out to
    // `+966501234567`. A string compare reports "never called back" here, which
    // is the single most damaging thing this feature could get wrong.
    const index = buildFollowUpIndex([answeredOutbound("c2", 5_000, "+966501234567", "1000")]);
    expect(findFirstFollowUp(index, "0501234567", 1_000)?.callId).toBe("c2");
  });

  it("ignores calls at or before the abandoned call", () => {
    const index = buildFollowUpIndex([
      answeredInbound("earlier", 500, "0501234567", "4005"),
      answeredInbound("same-instant", 1_000, "0501234567", "4005"),
    ]);
    expect(findFirstFollowUp(index, "0501234567", 1_000)).toBeNull();
  });

  it("returns the FIRST later call when there are several", () => {
    const index = buildFollowUpIndex([
      answeredOutbound("third", 9_000, "0501234567", "1000"),
      answeredInbound("first", 2_000, "0501234567", "4005"),
      answeredOutbound("second", 4_000, "0501234567", "1000"),
    ]);
    expect(findFirstFollowUp(index, "0501234567", 1_000)?.callId).toBe("first");
  });

  it("does not treat an internal call as a customer being reached", () => {
    // Two agents talking to each other afterwards is not a callback.
    const internal = call({
      callId: "int",
      startedAt: 3_000,
      direction: "Internal",
      callerNumber: "0501234567",
      outcome: "answered",
      answeringExtension: "4005",
    });
    expect(findFirstFollowUp(buildFollowUpIndex([internal]), "0501234567", 1_000)).toBeNull();
  });

  it("returns null for a customer with no history at all", () => {
    const index = buildFollowUpIndex([answeredInbound("other", 5_000, "0559999999", "4005")]);
    expect(findFirstFollowUp(index, "0501234567", 1_000)).toBeNull();
  });
});

describe("selectUnansweredCalls", () => {
  const calls = [
    abandoned("a1", 1_000, "0501234567"),
    abandoned("a2", 2_000, "0559999999"),
    call({ callId: "m1", startedAt: 3_000, callerNumber: "0507777777", outcome: "missed" }),
    answeredOutbound("cb1", 6_000, "966501234567", "1000"),
  ];

  it("selects only the requested outcome and attaches the follow-up", () => {
    const out = selectUnansweredCalls({
      calls,
      kind: "abandoned",
      agentByExt: AGENTS,
      limit: 100,
    });

    expect(out.rows.map((r) => r.callId)).toEqual(["a2", "a1"]); // newest first
    expect(out.total).toBe(2);
    expect(out.handled).toBe(1);
    expect(out.truncated).toBe(false);

    const handled = out.rows.find((r) => r.callId === "a1")!.handled;
    expect(handled).toMatchObject({
      callId: "cb1",
      agentName: "Ahmed Mousad",
      team: "telesales",
      direction: "Outbound",
      afterSeconds: 5_000,
    });
    expect(out.rows.find((r) => r.callId === "a2")!.handled).toBeNull();
  });

  it("reads the missed population off the same window", () => {
    const out = selectUnansweredCalls({ calls, kind: "missed", agentByExt: AGENTS, limit: 100 });
    expect(out.rows.map((r) => r.callId)).toEqual(["m1"]);
    expect(out.rows[0].outcome).toBe("missed");
    expect(out.rows[0].waitSeconds).toBe(3);
  });

  it("caps the rows but still reports the true population", () => {
    const many = Array.from({ length: 5 }, (_, i) => abandoned(`x${i}`, 1_000 + i));
    const out = selectUnansweredCalls({
      calls: many,
      kind: "abandoned",
      agentByExt: AGENTS,
      limit: 2,
    });
    expect(out.rows).toHaveLength(2);
    expect(out.total).toBe(5);
    expect(out.truncated).toBe(true);
    // The cap keeps the most recent, which is what a supervisor acts on.
    expect(out.rows.map((r) => r.callId)).toEqual(["x4", "x3"]);
  });

  it("names an unrostered extension as unknown rather than guessing", () => {
    const out = selectUnansweredCalls({
      calls: [abandoned("a1", 1_000), answeredOutbound("cb", 2_000, "0501234567", "9999")],
      kind: "abandoned",
      agentByExt: AGENTS,
      limit: 10,
    });
    expect(out.rows[0].handled).toMatchObject({ agentExt: "9999", agentName: null, team: null });
  });

  it("finds a follow-up that business rules excluded from the KPIs", () => {
    // An after-hours callback still reached the customer. Only the KPI
    // population is `calls`; the follow-up search sees the whole window.
    const excluded = call({
      ...answeredInbound("late", 4_000, "0501234567", "4005"),
      exclusion: "after_hours",
      operational: false,
    });
    const out = selectUnansweredCalls({
      calls: [abandoned("a1", 1_000)],
      followUpSource: [abandoned("a1", 1_000), excluded],
      kind: "abandoned",
      agentByExt: AGENTS,
      limit: 10,
    });
    expect(out.rows[0].handled?.callId).toBe("late");
    expect(out.handled).toBe(1);
  });
});
