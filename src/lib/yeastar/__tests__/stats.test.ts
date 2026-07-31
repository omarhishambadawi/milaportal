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
import {
  buildContext,
  isWithinBusinessHours,
  parseBusinessHours,
  type RawCdrRow,
} from "../normalize";
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
    call_to: "0501234523",
    call_to_number: "0501234523",
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
    call_to: "0509876588",
    call_to_number: "0509876588",
    // Rang the full 60s timeout — a genuine no-answer, not an agent hang-up.
    duration: 60,
    ring_duration: 60,
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
    // 15 non-internal rows collapse to 6 calls, of which 5 are operational —
    // the IVR-only hang-up is reported but never counted (Phase 3 rule).
    expect(r.totals.total).toBe(5);
    expect(r.totals.inbound).toBe(3);
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

  it("reports IVR-only calls but keeps them out of every KPI", () => {
    // Parity target is Yeastar Reports > Extension Call Statistics, which counts
    // only calls that reached an extension. An IVR hang-up never did.
    expect(r.totals.ivrOnly).toBe(1);
    expect(r.totals.inbound).toBe(r.totals.inboundAnswered + 1 + 1); // answered + missed + abandoned
    expect(run(IVR_ONLY).totals.total).toBe(0);
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

  it("computes the platform answer rate over operational calls", () => {
    expect(r.totals.answerRate).toBeCloseTo((2 / 5) * 100, 6);
  });

  it("computes inbound answer rate without IVR hang-ups in the denominator", () => {
    expect(r.totals.inboundAnswerRate).toBeCloseTo((1 / 3) * 100, 6);
  });

  it("computes queue answer rate over calls agents were actually offered", () => {
    expect(r.totals.queueAnswerRate).toBeCloseTo((1 / 3) * 100, 6);
  });

  it("computes missed and abandon rates against operational inbound", () => {
    expect(r.totals.missedRate).toBeCloseTo((1 / 3) * 100, 6);
    expect(r.totals.abandonRate).toBeCloseTo((1 / 3) * 100, 6);
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
    // Every operational inbound call here reached the queue; the one that did
    // not is the IVR-only call, already excluded.
    expect(r.totals.queueCalls).toBe(r.totals.inbound);
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
    expect(r.byDay[0].total).toBe(5);
    expect(r.byDay[0].answered).toBe(2);
    expect(r.byDay[0].missed).toBe(1);
    expect(r.byDay[0].abandoned).toBe(1);
    expect(r.byDay[0].talkSeconds).toBe(194);
    expect(r.byDay[0].waitSeconds).toBe(33);
  });

  it("returns all 24 hours with the calls in the right one", () => {
    expect(r.byHour).toHaveLength(24);
    expect(r.byHour[HOUR].total).toBe(5);
    expect(r.byHour.reduce((n, h) => n + h.total, 0)).toBe(5);
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
    expect(run(ALL_ROWS, [], { direction: "Inbound" }).totals.total).toBe(3);
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
    expect(r.conversion.perDay[0]).toEqual({
      date: DAY,
      answered: 2,
      orders: 2,
      rate: 100,
      revenue: 400,
    });
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
    // Counted across both ledgers: grouping is what's under test here, not the
    // business rule that later excludes the IVR-only call.
    const c = classifyRecords([...IVR_ONLY, ...MISSED, ...ABANDONED], ctx);
    expect(c.calls.length + c.excluded.length).toBe(3);
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
    const c = classifyRecords(liveRows, liveCtx);
    expect(liveRows).toHaveLength(12);
    expect(c.calls.length + c.excluded.length).toBe(4);
    // Two of the four are IVR hang-ups, excluded from KPIs but still reported.
    expect(c.calls).toHaveLength(2);
    expect(c.exclusionCounts.find((e) => e.reason === "ivr_only")?.count).toBe(2);
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
    // The old parser scored all four of these as answered. Two are callers who
    // hung up in the IVR — reported, not counted. The fourth is the call whose
    // agent leg falls on the next page of this 12-row capture, so it reads as
    // queued and unanswered here.
    expect(r.totals.inbound).toBe(2);
    expect(r.totals.answered).toBe(1);
    expect(r.totals.ivrOnly).toBe(2);
    expect(r.totals.missed).toBe(1);
    expect(r.totals.talkSeconds).toBe(74);
  });

  it("passes every KPI invariant on the live payload", () => {
    const classified = classifyRecords(liveRows, liveCtx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    expect(failedChecks(validateAnalytics(classified, result))).toEqual([]);
  });
});

describe("KPI validation invariants", () => {
  it("passes every invariant on the live-transcribed fixture set", () => {
    const classified = classifyRecords(ALL_ROWS, ctx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    const failures = failedChecks(validateAnalytics(classified, result));
    expect(failures.map((f) => `${f.name}: expected ${f.expected}, got ${f.actual}`)).toEqual([]);
  });

  it("catches an inflated answered count", () => {
    const classified = classifyRecords(ALL_ROWS, ctx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    // Simulate the old bug: every inbound call scored as answered.
    result.totals.answered = result.totals.total;
    const failures = failedChecks(validateAnalytics(classified, result));
    expect(failures.map((f) => f.name)).toContain("answered");
  });

  it("catches multiplied talk seconds", () => {
    const classified = classifyRecords(ALL_ROWS, ctx);
    const result = aggregateClassified(classified, AGENTS, [], { tzOffsetMin: TZ });
    result.totals.talkSeconds *= 2;
    const failures = failedChecks(validateAnalytics(classified, result));
    expect(failures.map((f) => f.name)).toContain("talk-seconds");
  });
});

describe("direction accuracy (Phase 3)", () => {
  /**
   * The reported production defect: outbound calls appearing in inbound
   * analytics. Two outbound Busy calls put the dashboard at Inbound 46 against
   * an official Yeastar Inbound of 44.
   *
   * The signature is a row the PBX labels `Inbound` whose `call_from_number` is
   * one of our own extensions. An inbound call's caller is external by
   * definition, so the label is wrong and the endpoints win.
   */
  const OUTBOUND_BUSY_MISLABELLED: RawCdrRow[] = [
    {
      uid: "20260630220000A777",
      new_id: "67C6751A-06000001",
      call_id: "c-out-busy-mislabelled",
      timestamp: T + 1200,
      call_type: "Inbound", // ← wrong: the caller below is our own extension
      disposition: "BUSY",
      call_from: "Ahmed Mousad<1000>",
      call_from_number: "1000",
      call_to: "0512223344",
      call_to_number: "0512223344",
      duration: 4,
      ring_duration: 4,
    },
  ];

  it("never counts a call placed from one of our extensions as inbound", () => {
    const r = run(OUTBOUND_BUSY_MISLABELLED);
    expect(r.totals.inbound).toBe(0);
    expect(r.totals.outbound).toBe(1);
    expect(r.totals.busy).toBe(1);
  });

  it("records the correction so it can be audited, not silently applied", () => {
    const c = classifyRecords(OUTBOUND_BUSY_MISLABELLED, ctx);
    expect(c.directionCorrections).toEqual([
      { declared: "Inbound", corrected: "Outbound", count: 1 },
    ]);
  });

  it("reproduces the reported 46 → 44 inbound correction", () => {
    const twoBusy: RawCdrRow[] = [
      ...OUTBOUND_BUSY_MISLABELLED,
      {
        ...OUTBOUND_BUSY_MISLABELLED[0],
        new_id: "67C6751A-06000002",
        call_id: "c-out-busy-mislabelled-2",
        timestamp: T + 1260,
      },
    ];
    const withDefect = run([...ALL_ROWS, ...twoBusy]);
    const baseline = run(ALL_ROWS);
    // The two extra calls land in outbound, and inbound is untouched.
    expect(withDefect.totals.inbound).toBe(baseline.totals.inbound);
    expect(withDefect.totals.outbound).toBe(baseline.totals.outbound + 2);
  });

  it("treats an internally-placed call with no external leg as Internal, not inbound", () => {
    const extToExt: RawCdrRow[] = [
      {
        ...OUTBOUND_BUSY_MISLABELLED[0],
        new_id: "67C6751A-07000001",
        call_id: "c-ext-to-ext",
        call_to: "Fadwa Shawky<4006>",
        call_to_number: "4006",
      },
    ];
    const r = run(extToExt);
    expect(r.totals.total).toBe(0);
    expect(r.totals.inbound).toBe(0);
    expect(r.totals.outbound).toBe(0);
  });

  it("leaves correctly-labelled outbound alone", () => {
    const c = classifyRecords([...OUTBOUND_ANSWERED, ...OUTBOUND_NO_ANSWER], ctx);
    expect(c.directionCorrections).toEqual([]);
    expect(c.calls.every((x) => x.direction === "Outbound")).toBe(true);
  });
});

describe("operational business rules (Phase 3)", () => {
  it("keeps a full ledger of why each call was excluded", () => {
    const c = classifyRecords(ALL_ROWS, ctx);
    const byReason = Object.fromEntries(c.exclusionCounts.map((e) => [e.reason, e.count]));
    expect(byReason).toEqual({ ivr_only: 1, internal: 1 });
    expect(c.calls).toHaveLength(5);
    expect(c.excluded).toHaveLength(2);
  });

  it("counts duplicate rows dropped during grouping", () => {
    const c = classifyRecords([...QUEUE_ANSWERED, ...QUEUE_ANSWERED], ctx);
    expect(c.duplicateRowsDropped).toBe(6);
    expect(c.calls).toHaveLength(1);
  });

  it("excludes PBX system events with no counterparty at all", () => {
    const systemRow: RawCdrRow[] = [
      {
        uid: "20260630230000B888",
        new_id: "67C6751A-08000001",
        call_id: "c-system",
        timestamp: T + 2000,
        call_type: "Inbound",
        disposition: "ANSWERED",
        call_from_number: "",
        call_to: "Play Prompt",
        call_to_number: "",
        duration: 3,
      },
    ];
    const c = classifyRecords(systemRow, ctx);
    expect(c.calls).toHaveLength(0);
    expect(c.exclusionCounts).toEqual([{ reason: "system_event", count: 1 }]);
  });

  it("never drops a real call just because its destination did not parse", () => {
    // A destination the leg classifier cannot label must not make the call
    // disappear — exclusion is far more damaging than a mislabelled leg.
    const oddDestination: RawCdrRow[] = [
      {
        ...OUTBOUND_ANSWERED[0],
        new_id: "67C6751A-09000001",
        call_id: "c-odd-dest",
        call_to: "sip:pharmacy@partner.example",
        call_to_number: "sip:pharmacy@partner.example",
      },
    ];
    const r = run(oddDestination);
    expect(r.totals.total).toBe(1);
    expect(r.totals.outbound).toBe(1);
    expect(r.totals.answered).toBe(1);
  });
});

describe("business hours (Phase 3)", () => {
  const withHours = (spec: string) =>
    buildContext(
      [{ number: "4005" }, { number: "4006" }, { number: "1000" }, { number: "1001" }],
      [{ number: "6400" }],
      undefined,
      parseBusinessHours(spec, TZ),
    );

  it("applies no after-hours rule when hours are not configured", () => {
    // Default posture: an unverified window would silently move every KPI.
    expect(parseBusinessHours("", TZ)).toBeNull();
    expect(parseBusinessHours(undefined, TZ)).toBeNull();
    expect(ctx.businessHours ?? null).toBeNull();
    expect(
      classifyRecords(ALL_ROWS, ctx).exclusionCounts.some((e) => e.reason === "after_hours"),
    ).toBe(false);
  });

  it("parses day ranges, lists and wrapping windows", () => {
    expect(parseBusinessHours("sun-thu 08:00-17:00", TZ)).toEqual({
      days: [0, 1, 2, 3, 4],
      startMinute: 480,
      endMinute: 1020,
      utcOffsetMinutes: TZ,
    });
    expect(parseBusinessHours("sat,sun 09:30-22:00", TZ)?.days).toEqual([0, 6]);
    expect(parseBusinessHours("fri-mon 09:00-17:00", TZ)?.days).toEqual([0, 1, 5, 6]);
    expect(parseBusinessHours("garbage", TZ)).toBeNull();
  });

  it("excludes calls that arrive outside the window", () => {
    // The fixtures all start 21:37 local on a Tuesday.
    const office = withHours("sun-thu 08:00-17:00");
    const c = classifyRecords(ALL_ROWS, office);
    const byReason = Object.fromEntries(c.exclusionCounts.map((e) => [e.reason, e.count]));
    expect(byReason.after_hours).toBeGreaterThan(0);
    expect(c.calls).toHaveLength(0);
  });

  it("keeps calls that arrive inside the window", () => {
    const evening = withHours("sun-sat 18:00-23:59");
    const c = classifyRecords(ALL_ROWS, evening);
    expect(c.calls).toHaveLength(5);
    expect(c.exclusionCounts.some((e) => e.reason === "after_hours")).toBe(false);
  });

  it("reports a queued call that arrived while the queue was closed separately", () => {
    const office = withHours("sun-thu 08:00-17:00");
    // ABANDONED reached the queue and never rang an agent.
    const c = classifyRecords(ABANDONED, office);
    expect(c.exclusionCounts).toEqual([{ reason: "queue_closed", count: 1 }]);
  });

  it("treats a window that wraps past midnight correctly", () => {
    const overnight = parseBusinessHours("sun-sat 22:00-06:00", TZ)!;
    // 21:37 local is outside; 23:00 is inside.
    expect(isWithinBusinessHours(T, overnight)).toBe(false);
    expect(isWithinBusinessHours(T + 90 * 60, overnight)).toBe(true);
  });
});

describe("telesales: agent cancelled calls (Phase 4A)", () => {
  /**
   * Reference day 30/07/2026, Yeastar Reports > Extension Call Statistics:
   *
   *   Total 158 = Answered 100 + No Answer 29 + Busy 15 + Failed 0 + 14
   *
   * The dashboard reported No Answer 43 — exactly 29 + 14. Those 14 are calls
   * the AGENT hung up before the ring timeout expired. Yeastar counts them in
   * Total but not in No Answer; we folded them together.
   *
   * Both carry `disposition: "NO ANSWER"`, so ring duration is the only
   * discriminator: a customer who does not pick up rings the FULL timeout.
   */
  const outboundUnanswered = (id: string, ring: number): RawCdrRow => ({
    uid: `u-${id}`,
    new_id: `n-${id}`,
    call_id: id,
    timestamp: T + 900,
    call_type: "Outbound",
    disposition: "NO ANSWER",
    call_from: "Ahmed Mousad<1000>",
    call_from_number: "1000",
    call_to: "0501234523",
    call_to_number: "0501234523",
    duration: ring,
    ring_duration: ring,
  });

  it("splits an early hang-up from a genuine ring-out", () => {
    const r = run([outboundUnanswered("c-cancel", 7), outboundUnanswered("c-noanswer", 60)]);
    expect(r.totals.cancelledByAgent).toBe(1);
    expect(r.totals.noAnswerOutbound).toBe(1);
    // Both still count as calls — Yeastar's Total includes cancellations.
    expect(r.totals.total).toBe(2);
    expect(r.totals.outbound).toBe(2);
  });

  it("reproduces the 30/07/2026 No Answer split", () => {
    // 29 rang the full 60s timeout, 14 were cut short by the agent.
    const rows = [
      ...Array.from({ length: 29 }, (_, i) => outboundUnanswered(`ring-${i}`, 60)),
      ...Array.from({ length: 14 }, (_, i) => outboundUnanswered(`cut-${i}`, 5 + i)),
    ];
    const r = run(rows);
    expect(r.totals.total).toBe(43); // what the dashboard used to call "No Answer"
    expect(r.totals.noAnswerOutbound).toBe(29); // official figure
    expect(r.totals.cancelledByAgent).toBe(14); // the missing bucket
  });

  it("never invents a cancellation when the PBX omitted ring_duration", () => {
    const noRing: RawCdrRow = { ...outboundUnanswered("c-noring", 0), ring_duration: undefined };
    const r = run([noRing]);
    expect(r.totals.cancelledByAgent).toBe(0);
    expect(r.totals.noAnswerOutbound).toBe(1);
  });

  it("honours a configured ring timeout", () => {
    const ctx30 = buildContext(
      [{ number: "1000" }],
      [{ number: "6400" }],
      undefined,
      null,
      30, // PBX configured with a 30s outbound ring timeout
    );
    const rows = [outboundUnanswered("a", 20), outboundUnanswered("b", 45)];
    const r = aggregateAnalytics(rows, ctx30, AGENTS, [], { tzOffsetMin: TZ });
    expect(r.totals.cancelledByAgent).toBe(1); // 20 < 30
    expect(r.totals.noAnswerOutbound).toBe(1); // 45 >= 30
  });

  it("does not reuse queue-abandoned logic", () => {
    // Abandoned is a QUEUE concept and must stay at zero for outbound traffic,
    // however short the ring was.
    const r = run([outboundUnanswered("c-short", 1)]);
    expect(r.totals.abandoned).toBe(0);
    expect(r.totals.missed).toBe(0);
    expect(r.totals.cancelledByAgent).toBe(1);
  });

  it("reports cancel rate and average ring before cancel", () => {
    const rows = [
      outboundUnanswered("a", 4),
      outboundUnanswered("b", 8),
      outboundUnanswered("c", 60),
      { ...OUTBOUND_ANSWERED[0] },
    ];
    const r = run(rows);
    expect(r.totals.outbound).toBe(4);
    expect(r.totals.cancelledByAgent).toBe(2);
    expect(r.totals.agentCancelRate).toBe(50);
    expect(r.totals.avgRingBeforeCancelSec).toBe(6); // (4 + 8) / 2
  });

  it("attributes cancellations to the agent who made them", () => {
    const r = run([outboundUnanswered("a", 3), outboundUnanswered("b", 9)]);
    const ahmed = r.agents.find((x) => x.ext === "1000")!;
    expect(ahmed.cancelledByAgent).toBe(2);
    expect(ahmed.noAnswerOutbound).toBe(0);
  });
});

describe("telesales: lead contact rate (Phase 4A)", () => {
  it("is answered ÷ total outbound, distinct from conversion rate", () => {
    const orders: OrderRef[] = [
      {
        id: "o1",
        agent_id: "a-ts-1",
        order_date: DAY,
        status: "Completed",
        order_type: "Cash",
        invoice_value: 500,
      },
    ];
    const rows = [
      ...OUTBOUND_ANSWERED, // answered
      ...OUTBOUND_NO_ANSWER, // rang the full timeout, unanswered
    ];
    const r = run(rows, orders);
    expect(r.totals.outbound).toBe(2);
    expect(r.totals.outboundAnswered).toBe(1);
    // Reached 1 of 2 customers.
    expect(r.totals.leadContactRate).toBe(50);
    // Converted 1 of the 1 reached — a different question entirely.
    expect(r.conversion.overall.conversionRate).toBe(100);
    expect(r.totals.leadContactRate).not.toBe(r.conversion.overall.conversionRate);
  });

  it("is zero when nothing was dialled, never NaN", () => {
    const r = run(QUEUE_ANSWERED);
    expect(r.totals.outbound).toBe(0);
    expect(r.totals.leadContactRate).toBe(0);
    expect(r.totals.agentCancelRate).toBe(0);
    expect(r.totals.avgRingBeforeCancelSec).toBe(0);
  });

  it("exposes per-day series for the sales trends", () => {
    const cancelled: RawCdrRow = {
      uid: "u-day-cancel",
      new_id: "n-day-cancel",
      call_id: "c-day-cancel",
      timestamp: T + 950,
      call_type: "Outbound",
      disposition: "NO ANSWER",
      call_from_number: "1000",
      call_to: "0501112233",
      call_to_number: "0501112233",
      duration: 6,
      ring_duration: 6,
    };
    const r = run([...OUTBOUND_ANSWERED, ...OUTBOUND_NO_ANSWER, cancelled]);
    expect(r.byDay[0].outbound).toBe(3);
    expect(r.byDay[0].outboundAnswered).toBe(1);
    expect(r.byDay[0].cancelledByAgent).toBe(1);
  });

  it("carries revenue per day for the revenue trend", () => {
    const orders: OrderRef[] = [
      {
        id: "o1",
        agent_id: "a-ts-1",
        order_date: DAY,
        status: "Completed",
        order_type: "Cash",
        invoice_value: 250,
      },
      {
        id: "o2",
        agent_id: "a-ts-1",
        order_date: DAY,
        status: "Pending",
        order_type: "Cash",
        invoice_value: 150,
      },
    ];
    const r = run(OUTBOUND_ANSWERED, orders);
    expect(r.conversion.perDay[0].revenue).toBe(400);
  });
});

describe("customer care: service level (Phase 5)", () => {
  it("counts a queue call answered inside the target as within SLA", () => {
    // QUEUE_ANSWERED waited 11s in the queue, well inside the 60s target.
    const r = run(QUEUE_ANSWERED);
    expect(r.totals.slaSeconds).toBe(60);
    expect(r.totals.slaAnsweredWithin).toBe(1);
    expect(r.totals.slaAttainment).toBe(100);
  });

  it("measures SLA against calls offered to agents, not against every call", () => {
    // Answered (11s wait) + missed (20s) + abandoned (2s) = 3 offered, 1 in SLA.
    const r = run([...QUEUE_ANSWERED, ...MISSED, ...ABANDONED, ...IVR_ONLY]);
    expect(r.totals.slaAnsweredWithin).toBe(1);
    expect(r.totals.slaAttainment).toBeCloseTo((1 / 3) * 100, 6);
  });

  it("excludes a call answered outside the target from SLA but not from Answered", () => {
    const slow = QUEUE_ANSWERED.map((row) =>
      row.call_to_number === "6400" ? { ...row, ring_duration: 95 } : row,
    );
    const r = run(slow);
    expect(r.totals.answered).toBe(1);
    expect(r.totals.slaAnsweredWithin).toBe(0);
    expect(r.totals.slaAttainment).toBe(0);
  });

  it("honours a configured SLA target", () => {
    const r = run(QUEUE_ANSWERED, [], { slaSeconds: 5 });
    expect(r.totals.slaSeconds).toBe(5);
    expect(r.totals.slaAnsweredWithin).toBe(0); // waited 11s
  });

  it("is zero rather than NaN when nothing reached a queue", () => {
    const r = run(OUTBOUND_ANSWERED);
    expect(r.totals.slaAttainment).toBe(0);
    expect(r.totals.slaAnsweredWithin).toBe(0);
  });
});
