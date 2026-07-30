import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateAnalytics,
  classifyRecords,
  aggregateClassified,
  type AgentRef,
  type OrderRef,
} from "../stats.server";
import { buildContext, type RawCdrRow } from "../normalize";
import { failedChecks, validateAnalytics } from "../validate";

/**
 * Fixtures transcribed from live payloads captured on 2026-07-30 (Yeastar P570,
 * firmware 37.23.0.83) — see `docs/yeastar/samples/` and
 * `docs/yeastar/live-audit-2026-07-30.md`. External numbers are masked; the leg
 * structure, field presence and durations are verbatim.
 *
 * These tests exist to pin the KPI errors the audit measured, all of which came
 * from treating a CDR ROW as a call:
 *
 *   - Answered was over-counted by 1,834 because an `ANSWERED` IVR leg was read
 *     as a handled call.
 *   - Missed and Abandoned were structurally pinned to zero.
 *   - Inbound talk was under-reported by 65% (the IVR leg's talk_duration).
 *   - Average queue wait read 0.03s against a true 17.7s.
 *   - Outbound was — and must remain — untouched.
 */

const TZ = 180; // Asia/Riyadh, no DST
const T = 1782844637; // 30/06/2026 21:37:17 (+03:00)
const DAY = "2026-06-30";
const HOUR = 21;

const ctx = buildContext(
  [{ number: "4005" }, { number: "4006" }, { number: "1000" }, { number: "1001" }],
  [{ number: "6400" }],
);

const AGENTS: AgentRef[] = [
  { id: "a-cc-1", name: "Shams Rafiq", ext: "4005", team: "customer_care" },
  { id: "a-cc-2", name: "Fadwa Shawky", ext: "4006", team: "customer_care" },
  { id: "a-ts-1", name: "Ahmed Mousad", ext: "1000", team: "telesales" },
];

/**
 * An answered inbound queue call, verbatim from the live sample: three IVR
 * stages, the queue, the agent, then the satisfaction survey. Note that FIVE of
 * the six legs report `disposition: "ANSWERED"`, and that `talk_duration` 74
 * appears on both the queue leg and the agent leg.
 */
const QUEUE_ANSWERED: RawCdrRow[] = [
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-D30000CD",
    call_id: "c-answered",
    timestamp: T,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0538XXXX46",
    call_to: "IVR Welcome_AR_EN<6200>",
    call_to_number: "6200",
    did_number: "+966920032101",
    duration: 13,
    talk_duration: 13,
  },
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-D5C003DC",
    call_id: "c-answered",
    timestamp: T + 13,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0538XXXX46",
    call_to: "IVR Main_AR<6201>",
    call_to_number: "6201",
    duration: 5,
    talk_duration: 5,
  },
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-D7000111",
    call_id: "c-answered",
    timestamp: T + 18,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0538XXXX46",
    call_to: "IVR Home_Delivery_AR<6203>",
    call_to_number: "6203",
    duration: 34,
    talk_duration: 34,
  },
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-D8400257",
    call_id: "c-answered",
    timestamp: T + 52,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0538XXXX46",
    call_to: "Queue CC_Team<6400>",
    call_to_number: "6400",
    duration: 85,
    ring_duration: 11,
    talk_duration: 74,
  },
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-DAC0017D",
    call_id: "c-answered",
    timestamp: T + 63,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0538XXXX46",
    call_to: "Shams Rafiq<4005>",
    call_to_number: "4005",
    duration: 85,
    ring_duration: 11,
    talk_duration: 74,
  },
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-DE800042",
    call_id: "c-answered",
    timestamp: T + 137,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0538XXXX46",
    call_to: "Satisfaction Survey",
    call_to_number: "",
    duration: 4,
    talk_duration: 4,
  },
];

/** Caller hung up inside the IVR — never offered to an agent. */
const IVR_ONLY: RawCdrRow[] = [
  {
    uid: "20260630214144E9A1",
    new_id: "67C67519-E1000003",
    call_id: "c-ivr",
    timestamp: T + 200,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0552XXXX10",
    call_to: "IVR Welcome_AR_EN<6200>",
    call_to_number: "6200",
    duration: 12,
    talk_duration: 12,
  },
];

/** Queued, rang an agent for 20s, nobody took it. */
const MISSED: RawCdrRow[] = [
  {
    uid: "20260630214500B211",
    new_id: "67C6751A-01000001",
    call_id: "c-missed",
    timestamp: T + 300,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0555XXXX21",
    call_to: "IVR Welcome_AR_EN<6200>",
    call_to_number: "6200",
    duration: 15,
    talk_duration: 15,
  },
  {
    uid: "20260630214500B211",
    new_id: "67C6751A-01000002",
    call_id: "c-missed",
    timestamp: T + 315,
    call_type: "Inbound",
    disposition: "NO ANSWER",
    call_from_number: "0555XXXX21",
    call_to: "Queue CC_Team<6400>",
    call_to_number: "6400",
    duration: 20,
    ring_duration: 20,
  },
  {
    uid: "20260630214500B211",
    new_id: "67C6751A-01000003",
    call_id: "c-missed",
    timestamp: T + 315,
    call_type: "Inbound",
    disposition: "NO ANSWER",
    call_from_number: "0555XXXX21",
    call_to: "Fadwa Shawky<4006>",
    call_to_number: "4006",
    duration: 20,
    ring_duration: 20,
  },
];

/** Queued and hung up after 2s — abandoned, not missed. */
const ABANDONED: RawCdrRow[] = [
  {
    uid: "20260630215000C333",
    new_id: "67C6751A-02000001",
    call_id: "c-abandoned",
    timestamp: T + 600,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0533XXXX77",
    call_to: "IVR Welcome_AR_EN<6200>",
    call_to_number: "6200",
    duration: 8,
    talk_duration: 8,
  },
  {
    uid: "20260630215000C333",
    new_id: "67C6751A-02000002",
    call_id: "c-abandoned",
    timestamp: T + 608,
    call_type: "Inbound",
    disposition: "NO ANSWER",
    call_from_number: "0533XXXX77",
    call_to: "Queue CC_Team<6400>",
    call_to_number: "6400",
    duration: 2,
    ring_duration: 2,
  },
];

/** Outbound, single leg — the shape that was already correct. */
const OUTBOUND_ANSWERED: RawCdrRow[] = [
  {
    uid: "20260630215500D444",
    new_id: "67C6751A-03000001",
    call_id: "c-out-ok",
    timestamp: T + 900,
    call_type: "Outbound",
    disposition: "ANSWERED",
    call_from: "Ahmed Mousad<1000>",
    call_from_number: "1000",
    call_to: "0501XXXX23",
    call_to_number: "0501XXXX23",
    dod_number: "+966920032101",
    duration: 128,
    ring_duration: 8,
    talk_duration: 120,
  },
];

const OUTBOUND_NO_ANSWER: RawCdrRow[] = [
  {
    uid: "20260630215800E555",
    new_id: "67C6751A-04000001",
    call_id: "c-out-no",
    timestamp: T + 1000,
    call_type: "Outbound",
    disposition: "NO ANSWER",
    call_from: "Ahmed Mousad<1000>",
    call_from_number: "1000",
    call_to: "0509XXXX88",
    call_to_number: "0509XXXX88",
    duration: 25,
    ring_duration: 25,
  },
];

/** Extension-to-extension — excluded from every KPI. */
const INTERNAL: RawCdrRow[] = [
  {
    uid: "20260630215900F666",
    new_id: "67C6751A-05000001",
    call_id: "c-internal",
    timestamp: T + 1100,
    call_type: "Internal",
    disposition: "ANSWERED",
    call_from_number: "4005",
    call_to: "Fadwa Shawky<4006>",
    call_to_number: "4006",
    duration: 45,
    talk_duration: 45,
  },
];

const ALL_ROWS: RawCdrRow[] = [
  ...QUEUE_ANSWERED,
  ...IVR_ONLY,
  ...MISSED,
  ...ABANDONED,
  ...OUTBOUND_ANSWERED,
  ...OUTBOUND_NO_ANSWER,
  ...INTERNAL,
];

const run = (rows: RawCdrRow[] = ALL_ROWS, orders: OrderRef[] = [], opts = {}) =>
  aggregateAnalytics(rows, ctx, AGENTS, orders, { tzOffsetMin: TZ, ...opts });

describe("platform totals", () => {
  const r = run();

  it("counts calls, not CDR rows", () => {
    // 15 non-internal rows collapse to 6 calls.
    expect(r.totals.total).toBe(6);
    expect(r.totals.inbound).toBe(4);
    expect(r.totals.outbound).toBe(2);
  });

  it("excludes Internal calls from every KPI", () => {
    expect(run(INTERNAL).totals.total).toBe(0);
    // 4005 called 4006 internally; neither agent is credited for it.
    expect(r.agents.find((a) => a.ext === "4005")!.total).toBe(1);
    expect(r.agents.find((a) => a.ext === "4006")!.total).toBe(1);
  });

  it("counts only agent pickups as answered — an ANSWERED IVR leg is not a call answered", () => {
    // Every inbound fixture here has at least one ANSWERED leg. The old parser
    // scored all four as answered; only one had a human on it.
    expect(r.totals.answered).toBe(2); // 1 inbound + 1 outbound
    expect(r.totals.inboundAnswered).toBe(1);
  });

  it("reports Missed and Abandoned instead of pinning them to zero", () => {
    expect(r.totals.missed).toBe(1);
    expect(r.totals.abandoned).toBe(1);
  });

  it("separates IVR hang-ups from Missed", () => {
    expect(r.totals.ivrOnly).toBe(1);
    // The IVR-only call is still a call, and still drags the answer rate down.
    expect(r.totals.inbound).toBe(r.totals.inboundAnswered + 1 + 1 + 1);
  });
});

describe("talk time", () => {
  it("takes talk from the agent leg and counts it exactly once", () => {
    const r = run();
    // Queue leg and agent leg both report 74s. Summing legs gives 148 (or 208
    // with the IVR legs); the IVR leg alone gives 13. The answer is 74.
    expect(r.totals.talkSeconds).toBe(74 + 120);
    expect(r.totals.avgTalkSec).toBe(97);
  });

  it("never inflates talk by summing repeated leg values", () => {
    const inboundOnly = run(QUEUE_ANSWERED);
    expect(inboundOnly.totals.talkSeconds).toBe(74);
    expect(inboundOnly.totals.talkSeconds).not.toBe(148);
    expect(inboundOnly.totals.talkSeconds).not.toBe(13);
  });
});

describe("queue wait vs agent ring", () => {
  const r = run();

  it("takes wait from the queue leg, across every queued call", () => {
    // 11 (answered) + 20 (missed) + 2 (abandoned)
    expect(r.totals.waitSeconds).toBe(33);
    expect(r.totals.queueCalls).toBe(3);
  });

  it("averages wait over queued calls only — not over all inbound", () => {
    expect(r.totals.avgWaitSec).toBe(11);
  });

  it("keeps agent ring separate from queue wait", () => {
    // Agent ring on answered calls: 11 inbound + 8 outbound.
    expect(r.totals.ringSeconds).toBe(19);
    expect(r.totals.avgRingAnsweredSec).toBe(9.5);
  });

  it("does not lose wait when the PBX omits wait_time (it never sends it)", () => {
    expect(r.totals.avgWaitSec).toBeGreaterThan(0);
  });
});

describe("answer rates", () => {
  const r = run();

  it("computes the platform answer rate over every call", () => {
    expect(r.totals.answerRate).toBeCloseTo((2 / 6) * 100, 6);
  });

  it("computes inbound answer rate with IVR hang-ups in the denominator", () => {
    expect(r.totals.inboundAnswerRate).toBe(25);
  });

  it("computes queue answer rate over calls agents were actually offered", () => {
    expect(r.totals.queueAnswerRate).toBeCloseTo((1 / 3) * 100, 6);
  });

  it("computes missed and abandon rates against inbound", () => {
    expect(r.totals.missedRate).toBe(25);
    expect(r.totals.abandonRate).toBe(25);
  });
});

describe("outbound is preserved exactly", () => {
  const r = run([...OUTBOUND_ANSWERED, ...OUTBOUND_NO_ANSWER]);

  it("keeps outbound counts, talk and attribution unchanged", () => {
    expect(r.totals.total).toBe(2);
    expect(r.totals.outbound).toBe(2);
    expect(r.totals.answered).toBe(1);
    expect(r.totals.noAnswerOutbound).toBe(1);
    expect(r.totals.talkSeconds).toBe(120);
    expect(r.totals.missed).toBe(0);
    expect(r.totals.abandoned).toBe(0);
  });

  it("attributes an outbound call to the placing extension", () => {
    const ahmed = r.agents.find((a) => a.ext === "1000");
    expect(ahmed).toBeDefined();
    expect(ahmed!.outbound).toBe(2);
    expect(ahmed!.answered).toBe(1);
    expect(ahmed!.noAnswerOutbound).toBe(1);
    expect(ahmed!.talkSeconds).toBe(120);
    expect(ahmed!.ringSeconds).toBe(8);
  });

  it("never counts an outbound no-answer as a missed call", () => {
    expect(r.totals.missed).toBe(0);
  });
});

describe("agent KPIs", () => {
  const r = run();
  const byExt = (ext: string) => r.agents.find((a) => a.ext === ext);

  it("credits the agent who actually answered — never the queue or the IVR", () => {
    const shams = byExt("4005");
    expect(shams).toBeDefined();
    expect(shams!.answered).toBe(1);
    expect(shams!.inbound).toBe(1);
    expect(shams!.talkSeconds).toBe(74);
    expect(shams!.ringSeconds).toBe(11);
    expect(shams!.handlingSeconds).toBe(85);
    expect(shams!.longestSec).toBe(85);
    expect(shams!.answerRate).toBe(100);
  });

  it("counts an agent's own unanswered ring as their missed call", () => {
    const fadwa = byExt("4006");
    expect(fadwa).toBeDefined();
    expect(fadwa!.missed).toBe(1);
    expect(fadwa!.answered).toBe(0);
    expect(fadwa!.inbound).toBe(1);
  });

  it("never attributes a call to a queue number", () => {
    expect(r.agents.some((a) => a.ext === "6400")).toBe(false);
    expect(r.unmatched.extensions.some((e) => e.ext === "6400")).toBe(false);
  });

  it("does not attribute IVR-only calls to anybody", () => {
    const totalAgentInbound = r.agents.reduce((n, a) => n + a.inbound, 0);
    expect(totalAgentInbound).toBe(2); // the answered call and the missed ring
  });
});

describe("queue KPIs", () => {
  it("only counts calls that reached a queue as queue calls", () => {
    const r = run();
    expect(r.totals.queueCalls).toBe(3);
    // The IVR-only call never queued.
    expect(r.totals.queueCalls).toBe(r.totals.inbound - r.totals.ivrOnly);
  });

  it("classifies a short queue hang-up as abandoned and a long one as missed", () => {
    expect(run(ABANDONED).totals.abandoned).toBe(1);
    expect(run(ABANDONED).totals.missed).toBe(0);
    expect(run(MISSED).totals.missed).toBe(1);
    expect(run(MISSED).totals.abandoned).toBe(0);
  });
});

describe("day and hour buckets", () => {
  const r = run();

  it("buckets calls by business-timezone day", () => {
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0].date).toBe(DAY);
    expect(r.byDay[0].total).toBe(6);
    expect(r.byDay[0].answered).toBe(2);
    expect(r.byDay[0].missed).toBe(1);
    expect(r.byDay[0].abandoned).toBe(1);
    expect(r.byDay[0].talkSeconds).toBe(194);
    expect(r.byDay[0].waitSeconds).toBe(33);
  });

  it("returns all 24 hours with the calls in the right one", () => {
    expect(r.byHour).toHaveLength(24);
    expect(r.byHour[HOUR].total).toBe(6);
    expect(r.byHour.reduce((n, h) => n + h.total, 0)).toBe(6);
  });
});

describe("team comparison", () => {
  const r = run();

  it("rolls per-agent stats up per team", () => {
    const cc = r.teamCompare.find((t) => t.team === "customer_care")!;
    const ts = r.teamCompare.find((t) => t.team === "telesales")!;
    expect(cc.calls).toBe(2);
    expect(cc.answered).toBe(1);
    expect(cc.missed).toBe(1);
    expect(cc.talkSeconds).toBe(74);
    expect(ts.calls).toBe(2);
    expect(ts.answered).toBe(1);
    expect(ts.outbound).toBe(2);
    expect(ts.talkSeconds).toBe(120);
  });
});

describe("filters and scope", () => {
  it("filters by direction at call level", () => {
    expect(run(ALL_ROWS, [], { direction: "Inbound" }).totals.total).toBe(4);
    expect(run(ALL_ROWS, [], { direction: "Outbound" }).totals.total).toBe(2);
  });

  it("filters by status at call level", () => {
    expect(run(ALL_ROWS, [], { status: "ANSWERED" }).totals.total).toBe(2);
    expect(run(ALL_ROWS, [], { status: "NO ANSWER" }).totals.total).toBe(3);
  });

  it("scopes a team to its agents plus its own queue's unanswered calls", () => {
    const scoped = run(ALL_ROWS, [], {
      scope: { exts: new Set(["4005", "4006"]), ownedQueueNumbers: new Set(["6400"]) },
    });
    // Answered (4005), missed (4006 rang), abandoned (queued on 6400, nobody rang).
    expect(scoped.totals.total).toBe(3);
    expect(scoped.totals.answered).toBe(1);
    expect(scoped.totals.missed).toBe(1);
    expect(scoped.totals.abandoned).toBe(1);
    expect(scoped.totals.outbound).toBe(0);
  });

  it("scopes a single agent to the calls they took part in", () => {
    const scoped = run(ALL_ROWS, [], { scope: { exts: new Set(["1000"]) } });
    expect(scoped.totals.total).toBe(2);
    expect(scoped.totals.outbound).toBe(2);
    expect(scoped.totals.inbound).toBe(0);
  });
});

describe("conversion", () => {
  const orders: OrderRef[] = [
    {
      id: "o1",
      agent_id: "a-ts-1",
      order_date: DAY,
      status: "Completed",
      order_type: "Cash",
      invoice_value: 300,
    },
    {
      id: "o2",
      agent_id: "a-ts-1",
      order_date: DAY,
      status: "Pending",
      order_type: "Cash",
      invoice_value: 100,
    },
  ];

  it("divides orders by answered calls from the normalized pipeline", () => {
    const r = run(ALL_ROWS, orders);
    expect(r.conversion.overall.answered).toBe(2);
    expect(r.conversion.overall.orders).toBe(2);
    expect(r.conversion.overall.conversionRate).toBe(100);
    expect(r.conversion.overall.completionRate).toBe(50);
    expect(r.conversion.overall.revenue).toBe(400);
    expect(r.conversion.perDay[0]).toEqual({ date: DAY, answered: 2, orders: 2, rate: 100 });
  });

  it("joins per-agent conversion on the answered count that agent earned", () => {
    const r = run(ALL_ROWS, orders);
    const ahmed = r.conversion.perAgent.find((c) => c.ext === "1000")!;
    expect(ahmed.answered).toBe(1);
    expect(ahmed.ordersTotal).toBe(2);
    expect(ahmed.conversionRate).toBe(200);
    expect(ahmed.revenuePerCall).toBe(400);
  });
});

describe("grouping regressions the live audit found", () => {
  it("groups by call_id, keeping every leg", () => {
    const { calls } = classifyRecords(QUEUE_ANSWERED, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].legs).toHaveLength(6);
  });

  it("does NOT de-duplicate on uid — uid is a call id here, not a row id", () => {
    // All six legs share one uid. De-duplicating on it kept only the IVR leg.
    const uids = new Set(QUEUE_ANSWERED.map((r) => r.uid));
    expect(uids.size).toBe(1);
    const { calls } = classifyRecords(QUEUE_ANSWERED, ctx);
    expect(calls[0].legs.length).toBeGreaterThan(1);
    expect(calls[0].answeringExtension).toBe("4005");
  });

  it("de-duplicates repeated rows on new_id", () => {
    const doubled = [...QUEUE_ANSWERED, ...QUEUE_ANSWERED];
    const { calls } = classifyRecords(doubled, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].legs).toHaveLength(6);
    expect(
      aggregateAnalytics(doubled, ctx, AGENTS, [], { tzOffsetMin: TZ }).totals.talkSeconds,
    ).toBe(74);
  });

  it("does not merge unrelated calls that share a from/to pair", () => {
    const { calls } = classifyRecords([...IVR_ONLY, ...MISSED, ...ABANDONED], ctx);
    expect(calls).toHaveLength(3);
  });
});

describe("the captured live payload, end to end", () => {
  // Not a transcription — the actual `/cdr/search` response body captured from
  // the PBX on 2026-07-30, replayed through the production pipeline. The
  // extension roster comes from the captured `/extension/list` response and the
  // queue roster from `/queue/list`, exactly as the server builds them.
  const read = (name: string) =>
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../../docs/yeastar/samples/${name}`, import.meta.url)),
        "utf8",
      ),
    );

  const liveRows: RawCdrRow[] = read("cdr-search.json").response.data;
  const liveExtensions = read("extension-list.json").response;
  const liveQueues = read("queue-list.json").response.queue_list;
  const liveCtx = buildContext(liveExtensions.data, liveQueues);

  it("builds the roster the normalizer needs from the live responses", () => {
    expect(liveCtx.extensionNumbers.size).toBeGreaterThan(0);
    expect(liveCtx.queueNumbers.has("6400")).toBe(true);
    // A queue is never an agent, even if it turns up in both lists.
    expect(liveCtx.extensionNumbers.has("6400")).toBe(false);
  });

  it("recognises a queue member that /extension/list did not return", () => {
    // The captured /extension/list page holds 8 of the PBX's 28 extensions and
    // does not include 4005 — but 4005 is a member of queue 6400, and answers
    // the call below. Relying on /extension/list alone would classify that leg
    // as unknown and the call as missed.
    expect(liveExtensions.data.some((e: { number: string }) => e.number === "4005")).toBe(false);
    expect(liveCtx.extensionNumbers.has("4005")).toBe(true);
  });

  it("collapses 12 live rows into 4 calls", () => {
    const { calls } = classifyRecords(liveRows, liveCtx);
    expect(liveRows).toHaveLength(12);
    expect(calls).toHaveLength(4);
  });

  it("resolves the answering agent from the agent leg of the live call", () => {
    const { calls } = classifyRecords(liveRows, liveCtx);
    const answered = calls.find((c) => c.callId === "1782844637.854")!;
    expect(answered.outcome).toBe("answered");
    expect(answered.answeringExtension).toBe("4005");
    expect(answered.queueNumber).toBe("6400");
    expect(answered.queueWaitSeconds).toBe(11);
    expect(answered.talkSeconds).toBe(74); // once, not 74 + 74
    expect(answered.legs.map((l) => l.role)).toEqual([
      "ivr",
      "ivr",
      "ivr",
      "queue",
      "agent",
      "survey",
    ]);
  });

  it("does not score the live IVR hang-ups as answered calls", () => {
    const r = aggregateAnalytics(liveRows, liveCtx, AGENTS, [], { tzOffsetMin: TZ });
    // The old parser scored all four of these as answered. Two of them are
    // callers who hung up in the IVR; the fourth is the call whose agent leg
    // falls on the next page of this 12-row capture, so it reads as queued and
    // unanswered here.
    expect(r.totals.inbound).toBe(4);
    expect(r.totals.answered).toBe(1);
    expect(r.totals.ivrOnly).toBe(2);
    expect(r.totals.missed).toBe(1);
    expect(r.totals.talkSeconds).toBe(74);
  });

  it("passes every KPI invariant on the live payload", () => {
    const classified = classifyRecords(liveRows, liveCtx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    expect(failedChecks(validateAnalytics(classified.calls, result))).toEqual([]);
  });
});

describe("KPI validation invariants", () => {
  it("passes every invariant on the live-transcribed fixture set", () => {
    const classified = classifyRecords(ALL_ROWS, ctx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    const failures = failedChecks(validateAnalytics(classified.calls, result));
    expect(failures.map((f) => `${f.name}: expected ${f.expected}, got ${f.actual}`)).toEqual([]);
  });

  it("catches an inflated answered count", () => {
    const classified = classifyRecords(ALL_ROWS, ctx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    // Simulate the old bug: every inbound call scored as answered.
    result.totals.answered = result.totals.total;
    const failures = failedChecks(validateAnalytics(classified.calls, result));
    expect(failures.map((f) => f.name)).toContain("answered");
  });

  it("catches multiplied talk seconds", () => {
    const classified = classifyRecords(ALL_ROWS, ctx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    result.totals.talkSeconds *= 2;
    const failures = failedChecks(validateAnalytics(classified.calls, result));
    expect(failures.map((f) => f.name)).toContain("talk-seconds");
  });
});
