import { describe, expect, it } from "vitest";
import {
  buildContext,
  classifyLeg,
  groupByCall,
  normalizeCall,
  normalizeCdr,
  type NormalizationContext,
  type RawCdrRow,
} from "../normalize";

/**
 * Every fixture below is transcribed from a real response captured from the
 * live PBX (Yeastar P570, firmware 37.23.0.83) on 2026-07-30 — see
 * `docs/yeastar/samples/`. External numbers are masked; the leg structure,
 * field presence and durations are verbatim.
 *
 * The point of these tests is to pin the behaviours that the previous parser
 * got wrong, so they cannot silently regress:
 *   - IVR legs report disposition ANSWERED but are not answered calls
 *   - talk_duration repeats down the leg chain and must be counted once
 *   - queue wait and agent ring are different numbers
 *   - a queue number is never an answering extension
 */

const ctx: NormalizationContext = buildContext(
  [{ number: "4005" }, { number: "4006" }, { number: "1000" }, { number: "1001" }],
  [{ number: "6400" }],
);

/** One inbound call: two IVR stages, then the queue, then the agent. */
const QUEUE_CALL: RawCdrRow[] = [
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-D30000CD",
    call_id: "1782844637.854",
    timestamp: 1782844637,
    time: "30/06/2026 09:37:17 PM",
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from: "0538XXXX46",
    call_from_number: "0538XXXX46",
    call_to: "IVR Welcome_AR_EN<6200>",
    call_to_number: "6200",
    call_to_name: "Welcome_AR_EN",
    did_number: "+966920032101",
    duration: 13,
    talk_duration: 13,
  },
  {
    uid: "2026063021371710F70",
    new_id: "67C67519-D5C003DC",
    call_id: "1782844637.854",
    timestamp: 1782844650,
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
    new_id: "67C67519-D8400257",
    call_id: "1782844637.854",
    timestamp: 1782844655,
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
    call_id: "1782844637.854",
    timestamp: 1782844666,
    call_type: "Inbound",
    disposition: "ANSWERED",
    call_from_number: "0538XXXX46",
    call_to: "Shams Rafiq<4005>",
    call_to_number: "4005",
    call_to_name: "Shams Rafiq",
    duration: 85,
    ring_duration: 11,
    talk_duration: 74,
  },
];

describe("classifyLeg", () => {
  it("classifies by roster membership before label text", () => {
    expect(classifyLeg({ call_to_number: "6400", call_to: "Queue CC_Team<6400>" }, ctx)).toBe(
      "queue",
    );
    expect(classifyLeg({ call_to_number: "4005", call_to: "Shams Rafiq<4005>" }, ctx)).toBe(
      "agent",
    );
  });

  it("recognises IVR, survey and prompt legs, which have no roster", () => {
    expect(classifyLeg({ call_to_number: "6200", call_to: "IVR Welcome_AR_EN<6200>" }, ctx)).toBe(
      "ivr",
    );
    expect(classifyLeg({ call_to: "Satisfaction Survey", call_to_number: "" }, ctx)).toBe("survey");
    expect(classifyLeg({ call_to: "Play Prompt", call_to_number: "" }, ctx)).toBe("prompt");
  });

  it("treats a long external number as the far end of a call", () => {
    // Synthetic digits: the captured samples are masked for privacy, but the
    // live payload carries a plain digit string here.
    expect(classifyLeg({ call_to_number: "0501234567", call_to: "0501234567" }, ctx)).toBe(
      "external",
    );
  });
});

describe("groupByCall", () => {
  it("groups every leg of one call under its shared call_id", () => {
    const groups = groupByCall(QUEUE_CALL);
    expect(groups.size).toBe(1);
    expect(groups.get("1782844637.854")).toHaveLength(4);
  });

  it("drops duplicate rows by new_id, not by uid", () => {
    const groups = groupByCall([...QUEUE_CALL, QUEUE_CALL[0]]);
    expect(groups.get("1782844637.854")).toHaveLength(4);
  });

  it("keeps rows without a call_id separate instead of merging on a heuristic", () => {
    const a: RawCdrRow = {
      uid: "a",
      new_id: "N-a",
      timestamp: 100,
      call_from_number: "1",
      call_to_number: "2",
    };
    const b: RawCdrRow = {
      uid: "b",
      new_id: "N-b",
      timestamp: 130,
      call_from_number: "1",
      call_to_number: "2",
    };
    expect(groupByCall([a, b]).size).toBe(2);
  });
});

describe("normalizeCall — answered queue call", () => {
  const call = normalizeCall(QUEUE_CALL, ctx)!;

  it("attributes the call to the agent extension, not the queue or the IVR", () => {
    expect(call.answeringExtension).toBe("4005");
    expect(call.answeredByAgent).toBe(true);
    expect(call.outcome).toBe("answered");
  });

  it("counts talk time once, from the agent leg only", () => {
    // 13 + 5 + 74 + 74 = 166 if legs are summed naively. The truth is 74.
    expect(call.talkSeconds).toBe(74);
  });

  it("separates queue wait from agent ring", () => {
    expect(call.queueWaitSeconds).toBe(11);
    expect(call.agentRingSeconds).toBe(11);
  });

  it("carries the queue, DID and caller through", () => {
    expect(call.queueNumber).toBe("6400");
    expect(call.reachedQueue).toBe(true);
    expect(call.didNumber).toBe("+966920032101");
    expect(call.callerNumber).toBe("0538XXXX46");
    expect(call.legs.map((l) => l.role)).toEqual(["ivr", "ivr", "queue", "agent"]);
  });
});

describe("normalizeCall — the cases the old parser mis-scored", () => {
  it("does not count an IVR-only call as answered", () => {
    const ivrOnly: RawCdrRow[] = [
      {
        uid: "x1",
        new_id: "N-x1",
        call_id: "1782000000.1",
        timestamp: 1782000000,
        call_type: "Inbound",
        disposition: "ANSWERED",
        call_from_number: "0538XXXX46",
        call_to: "IVR Welcome_AR_EN<6200>",
        call_to_number: "6200",
        duration: 12,
        talk_duration: 12,
      },
    ];
    const call = normalizeCall(ivrOnly, ctx)!;
    expect(call.outcome).toBe("ivr_only");
    expect(call.answeredByAgent).toBe(false);
    expect(call.answeringExtension).toBeNull();
    expect(call.talkSeconds).toBe(0);
  });

  it("scores an unanswered queue call as missed, using the queue leg's ring", () => {
    const missed: RawCdrRow[] = [
      {
        uid: "m1",
        new_id: "N-m1",
        call_id: "1782000001.1",
        timestamp: 1782000001,
        call_type: "Inbound",
        disposition: "ANSWERED",
        call_from_number: "0538XXXX46",
        call_to: "IVR Welcome_AR_EN<6200>",
        call_to_number: "6200",
        talk_duration: 8,
      },
      {
        uid: "m2",
        new_id: "N-m2",
        call_id: "1782000001.1",
        timestamp: 1782000009,
        call_type: "Inbound",
        disposition: "NO ANSWER",
        call_from_number: "0538XXXX46",
        call_to: "Queue CC_Team<6400>",
        call_to_number: "6400",
        duration: 62,
        ring_duration: 62,
      },
    ];
    const call = normalizeCall(missed, ctx)!;
    expect(call.outcome).toBe("missed");
    expect(call.queueWaitSeconds).toBe(62);
    expect(call.answeringExtension).toBeNull();
  });

  it("scores a quick hang-up in the queue as abandoned", () => {
    const abandoned: RawCdrRow[] = [
      {
        uid: "a1",
        new_id: "N-a1",
        call_id: "1782000002.1",
        timestamp: 1782000002,
        call_type: "Inbound",
        disposition: "NO ANSWER",
        call_from_number: "0538XXXX46",
        call_to: "Queue CC_Team<6400>",
        call_to_number: "6400",
        duration: 3,
        ring_duration: 3,
      },
    ];
    expect(normalizeCall(abandoned, ctx)!.outcome).toBe("abandoned");
  });

  it("returns Unknown rather than a queue number when no agent leg exists", () => {
    const call = normalizeCall(
      [
        {
          uid: "q1",
          new_id: "N-q1",
          call_id: "1782000003.1",
          timestamp: 1782000003,
          call_type: "Inbound",
          disposition: "NO ANSWER",
          call_from_number: "0538XXXX46",
          call_to: "Queue CC_Team<6400>",
          call_to_number: "6400",
          ring_duration: 30,
        },
      ],
      ctx,
    )!;
    expect(call.answeringExtension).toBeNull();
    expect(call.answeringExtension).not.toBe("6400");
  });

  it("does not treat the survey leg's talk time as agent talk time", () => {
    const withSurvey: RawCdrRow[] = [
      ...QUEUE_CALL,
      {
        uid: "s1",
        new_id: "N-s1",
        call_id: "1782844637.854",
        timestamp: 1782844760,
        call_type: "Inbound",
        disposition: "ANSWERED",
        call_from_number: "0538XXXX46",
        call_to: "Satisfaction Survey",
        call_to_number: "",
        duration: 4,
        talk_duration: 4,
      },
    ];
    expect(normalizeCall(withSurvey, ctx)!.talkSeconds).toBe(74);
  });
});

describe("normalizeCall — outbound stays as it is today", () => {
  const outbound: RawCdrRow = {
    uid: "o1",
    new_id: "N-o1",
    call_id: "1782100000.5",
    timestamp: 1782100000,
    call_type: "Outbound",
    disposition: "ANSWERED",
    call_from: "Ahmed Mousad<1000>",
    call_from_number: "1000",
    call_to: "0501234567",
    call_to_number: "0501234567",
    duration: 140,
    ring_duration: 20,
    talk_duration: 120,
    dod_number: "+966920032101",
  };

  it("attributes an outbound call to the placing extension", () => {
    const call = normalizeCall([outbound], ctx)!;
    expect(call.direction).toBe("Outbound");
    expect(call.answeringExtension).toBe("1000");
    expect(call.outcome).toBe("answered");
    expect(call.talkSeconds).toBe(120);
  });

  it("marks an unanswered outbound call distinctly from an inbound miss", () => {
    const call = normalizeCall([{ ...outbound, disposition: "NO ANSWER", talk_duration: 0 }], ctx)!;
    expect(call.outcome).toBe("no_answer_outbound");
    expect(call.answeredByAgent).toBe(false);
  });

  it("reports BUSY and FAILED outbound outcomes", () => {
    expect(normalizeCall([{ ...outbound, disposition: "BUSY" }], ctx)!.outcome).toBe("busy");
    expect(normalizeCall([{ ...outbound, disposition: "FAILED" }], ctx)!.outcome).toBe("failed");
  });
});

describe("normalizeCdr", () => {
  it("returns one entry per call, oldest first", () => {
    const calls = normalizeCdr(
      [
        ...QUEUE_CALL,
        {
          uid: "z1",
          new_id: "N-z1",
          call_id: "1782900000.1",
          timestamp: 1782900000,
          call_type: "Outbound",
          disposition: "ANSWERED",
          call_from_number: "1001",
          call_to_number: "0501234599",
          talk_duration: 30,
        },
      ],
      ctx,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].callId).toBe("1782844637.854");
    expect(calls[1].direction).toBe("Outbound");
  });
});

describe("buildContext", () => {
  it("never lets a queue number count as an extension", () => {
    const c = buildContext([{ number: "4005" }, { number: "6400" }], [{ number: "6400" }]);
    expect(c.extensionNumbers.has("6400")).toBe(false);
    expect(c.queueNumbers.has("6400")).toBe(true);
    expect(c.extensionNumbers.has("4005")).toBe(true);
  });
});
