/**
 * Reading a refusal.
 *
 * ## The incident
 *
 * An order reached AlShrouq and came back refused. What the agent saw was:
 *
 *     AlShrouq refused the delivery. No courier was sent.
 *
 * Both sentences true, and together they say nothing anyone can act on. The
 * CRM had answered with a 4xx and a body; `createAlshrouqOrder` had received
 * that body, sanitized it, and handed it to `dispatchOrderToAlShrouq`, which
 * dropped it on the floor and substituted a constant. Nothing was logged and
 * nothing was persisted, so there was no way — short of reproducing the refusal
 * — to find out which field the CRM had objected to.
 *
 * These tests cover the module that reads the reason back out.
 *
 * ## What is and is not verified here
 *
 * The **error** shape of `POST /integrations/alshrouq/orders` has never been
 * captured from the real endpoint, and no test here claims otherwise. The
 * shapes below are the ones an HTTP JSON API uses, with FastAPI's `detail`
 * first because the CRM presents as FastAPI. The module returns `null` for
 * anything it does not recognise and the caller falls back to the generic
 * sentence — so an unrecognised shape is exactly as informative as today, never
 * worse, and no reason is ever invented.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  describeAlshrouqRejection,
  readAlshrouqRejectionCode,
  readAlshrouqRejectionReason,
  rejectionBodyShape,
} from "@/lib/shams-crm/alshrouq-rejection";

describe("readAlshrouqRejectionReason", () => {
  it("gives nothing for an absent body, so the caller keeps the generic sentence", () => {
    expect(readAlshrouqRejectionReason(null)).toBeNull();
    expect(readAlshrouqRejectionReason(undefined)).toBeNull();
    expect(readAlshrouqRejectionReason("")).toBeNull();
    expect(readAlshrouqRejectionReason("   ")).toBeNull();
  });

  it("takes a bare string body as its own reason", () => {
    expect(readAlshrouqRejectionReason("Branch is not active")).toBe("Branch is not active");
  });

  it("reads FastAPI's string detail", () => {
    expect(readAlshrouqRejectionReason({ detail: "Invalid branch_id" })).toBe("Invalid branch_id");
  });

  /**
   * The shape most likely behind a real 4xx on this endpoint: FastAPI reports
   * request-validation failures as a list of `{loc, msg}`.
   */
  it("reads FastAPI's validation list and names the field", () => {
    const body = {
      detail: [
        {
          loc: ["body", "customer_phone"],
          msg: "string does not match regex",
          type: "value_error",
        },
      ],
    };
    expect(readAlshrouqRejectionReason(body)).toBe("customer_phone: string does not match regex");
  });

  it("joins several validation failures and caps the list", () => {
    const body = {
      detail: [
        { loc: ["body", "a"], msg: "one" },
        { loc: ["body", "b"], msg: "two" },
        { loc: ["body", "c"], msg: "three" },
        { loc: ["body", "d"], msg: "four" },
      ],
    };
    const reason = readAlshrouqRejectionReason(body);
    expect(reason).toContain("a: one");
    expect(reason).toContain("c: three");
    // The fourth is counted rather than printed — a toast is not a log.
    expect(reason).toContain("(+1 more)");
  });

  it("drops the uninformative leading `body` segment", () => {
    const reason = readAlshrouqRejectionReason({ detail: [{ loc: ["body"], msg: "bad request" }] });
    expect(reason).toBe("bad request");
  });

  it("reads the other common message keys", () => {
    expect(readAlshrouqRejectionReason({ message: "no" })).toBe("no");
    expect(readAlshrouqRejectionReason({ error: "nope" })).toBe("nope");
    expect(readAlshrouqRejectionReason({ error_message: "still no" })).toBe("still no");
    expect(readAlshrouqRejectionReason({ reason: "because" })).toBe("because");
  });

  it("reads a nested error object", () => {
    expect(readAlshrouqRejectionReason({ error: { message: "branch closed" } })).toBe(
      "branch closed",
    );
  });

  it("reads the field-keyed errors map", () => {
    const reason = readAlshrouqRejectionReason({
      errors: { customer_phone: ["is invalid"], value: ["must be positive"] },
    });
    expect(reason).toContain("customer_phone");
    expect(reason).toContain("is invalid");
    expect(reason).toContain("value");
  });

  /* ---------------------------------------------------------------------- */
  /* Safety                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * `sanitizeResponseBody` replaces credential-shaped keys with `[redacted]`
   * before this module ever runs. This makes sure the marker is never mistaken
   * for the explanation and shown to an agent as one.
   */
  it("never reports the redaction marker as a reason", () => {
    expect(readAlshrouqRejectionReason({ detail: "[redacted]" })).toBeNull();
    expect(readAlshrouqRejectionReason({ message: "[redacted]", error: "real reason" })).toBe(
      "real reason",
    );
  });

  it("caps a very long reason", () => {
    const reason = readAlshrouqRejectionReason({ detail: "x".repeat(1000) });
    expect(reason!.length).toBeLessThanOrEqual(241);
    expect(reason!.endsWith("…")).toBe(true);
  });

  it("survives shapes it does not recognise without throwing", () => {
    for (const body of [42, true, [], {}, { detail: {} }, { unrelated: 1 }, [null, undefined]]) {
      expect(() => readAlshrouqRejectionReason(body)).not.toThrow();
    }
    expect(readAlshrouqRejectionReason({ unrelated: 1 })).toBeNull();
  });
});

describe("readAlshrouqRejectionCode", () => {
  it("reads a string or numeric code", () => {
    expect(readAlshrouqRejectionCode({ code: "BRANCH_INACTIVE" })).toBe("BRANCH_INACTIVE");
    expect(readAlshrouqRejectionCode({ error_code: 4012 })).toBe("4012");
  });

  it("is null when there is none", () => {
    expect(readAlshrouqRejectionCode({ detail: "nope" })).toBeNull();
    expect(readAlshrouqRejectionCode(null)).toBeNull();
  });
});

describe("describeAlshrouqRejection", () => {
  /** The status is always present, because it is the one fact always available. */
  it("always names the HTTP status", () => {
    expect(describeAlshrouqRejection(422, null)).toContain("422");
    expect(describeAlshrouqRejection(400, { detail: "bad" })).toContain("400");
  });

  it("says so plainly when the CRM gave no reason", () => {
    const message = describeAlshrouqRejection(400, null);
    expect(message).toContain("gave no reason");
    // The fact an agent must never have to infer.
    expect(message).toContain("Nothing was dispatched.");
  });

  it("quotes the reason when there is one", () => {
    const message = describeAlshrouqRejection(422, {
      detail: [{ loc: ["body", "customer_phone"], msg: "invalid" }],
    });
    expect(message).toContain("customer_phone: invalid");
    expect(message).toContain("Nothing was dispatched.");
  });

  it("falls back to a code when that is all the body carries", () => {
    expect(describeAlshrouqRejection(409, { code: "DUPLICATE" })).toContain("DUPLICATE");
  });
});

describe("rejectionBodyShape", () => {
  /**
   * The last blind spot. If the CRM answers in a shape the reader above does
   * not recognise, the reason is `null` and the body would otherwise be
   * discarded — leaving the next incident exactly as undiagnosable as the one
   * that prompted all of this. Key names are enough to learn the shape from.
   */
  it("names the top-level keys of a shape it could not read", () => {
    expect(rejectionBodyShape({ status: "NOK", failures: ["x"], ref: 9 })).toEqual([
      "status",
      "failures",
      "ref",
    ]);
  });

  /** Names, never values — a key cannot be a phone number; a value can. */
  it("returns names only", () => {
    const shape = rejectionBodyShape({ customer_phone: "+966505628028", token: "abc" });
    expect(shape).toEqual(["customer_phone", "token"]);
    expect(shape.join(" ")).not.toContain("966505628028");
    expect(shape.join(" ")).not.toContain("abc");
  });

  it("describes a non-object body without inspecting it", () => {
    expect(rejectionBodyShape([1, 2, 3])).toEqual(["[array:3]"]);
    expect(rejectionBodyShape("boom")).toEqual(["[string]"]);
    expect(rejectionBodyShape(null)).toEqual([]);
  });

  it("caps a pathological body", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 50; i++) wide[`k${i}`] = i;
    expect(rejectionBodyShape(wide)).toHaveLength(12);
  });
});

describe("the order timeline surfaces a refusal", () => {
  const timeline = readFileSync(
    fileURLToPath(
      new URL("../../../features/orders/components/order-activity-timeline.tsx", import.meta.url),
    ),
    "utf8",
  );

  /**
   * A refusal that is written and not rendered is the same blindness with an
   * extra row in it, so the timeline is pinned to the constant rather than to a
   * repeated string literal.
   */
  it("renders the action and its reason", () => {
    expect(timeline).toContain("REJECTION_ACTIVITY_ACTION");
    expect(timeline).toContain("AlShrouq refused the delivery");
    expect(timeline).toContain("No reason given");
  });

  /** It reports a failure, so it must not read as an ordinary edit. */
  it("marks it as a failure on the rail", () => {
    expect(timeline).toContain('e.action === REJECTION_ACTIVITY_ACTION ? "danger"');
  });
});
