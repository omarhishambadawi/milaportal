/**
 * One reader for a coordinate, whatever it was pasted out of.
 *
 * ---------------------------------------------------------------------------
 * The failure this pins
 * ---------------------------------------------------------------------------
 * An agent pasted a latitude that carried one stray character — the comma left
 * behind by splitting `"24.53738, 46.64555"`, a compass letter, or the invisible
 * bidi mark a WhatsApp copy wraps a number in. The order form checked it with
 * the tolerant reader here, showed a green **Verified location**, and then saved
 * it through a bare `Number()` in `orderFormSchema`, which is `NaN` for all
 * three. The save failed with a validation error naming neither the field nor
 * the character, and the order could not be created at all.
 *
 * Two readers, one field. There is one now, and these are its rules — including
 * the ones about what it must *refuse*, because a reader that repairs
 * everything is how `"24,5"` becomes two hundred and forty-five.
 */

import { describe, expect, it } from "vitest";
import { coordinateNumber, parseCoordinatePair } from "../coordinates";
import { validateAlShrouqOrderFields } from "@/features/alshrouq/order-fields";
import { orderFormSchema } from "@/features/orders/schema";

/** The pin from the report, and the pair it was split out of. */
const LAT = 24.53738;
const LNG = 46.64555;

/** The bidi marks a WhatsApp copy out of an Arabic conversation carries. */
const RLM = "\u200F";
const LRM = "\u200E";

describe("coordinateNumber — what it reads", () => {
  it("reads a plain decimal, signed or not", () => {
    expect(coordinateNumber("24.53738")).toBe(LAT);
    expect(coordinateNumber("-24.53738")).toBe(-LAT);
    expect(coordinateNumber("+24.53738")).toBe(LAT);
    expect(coordinateNumber(24.53738)).toBe(LAT);
  });

  it("reads through the whitespace a paste brings", () => {
    expect(coordinateNumber(" 24.53738 ")).toBe(LAT);
    expect(coordinateNumber("24.53738\n")).toBe(LAT);
    expect(coordinateNumber("\t24.53738\r\n")).toBe(LAT);
    // A non-breaking space, which is what a copy out of a web page leaves.
    expect(coordinateNumber("\u00A024.53738\u00A0")).toBe(LAT);
  });

  it("reads through a separator left by splitting a pair", () => {
    expect(coordinateNumber("24.53738,")).toBe(LAT);
    expect(coordinateNumber(",24.53738")).toBe(LAT);
    expect(coordinateNumber("24.53738;")).toBe(LAT);
    expect(coordinateNumber(" 24.53738 , ")).toBe(LAT);
  });

  it("reads through the invisible characters a WhatsApp copy adds", () => {
    expect(coordinateNumber(`${RLM}24.53738${LRM}`)).toBe(LAT);
    // Zero-width space, zero-width joiner, byte-order mark, soft hyphen.
    expect(coordinateNumber("24.53738\u200B")).toBe(LAT);
    expect(coordinateNumber("\u200D24.53738")).toBe(LAT);
    expect(coordinateNumber("\uFEFF24.53738")).toBe(LAT);
    expect(coordinateNumber("24.5\u00AD3738")).toBe(LAT);
    // And the combination, which is what an actual paste looks like.
    expect(coordinateNumber(`${RLM} 24.53738, ${LRM}`)).toBe(LAT);
  });

  it("reads Arabic-Indic digits", () => {
    expect(coordinateNumber("٢٤.٥٣٧٣٨")).toBe(LAT);
    expect(coordinateNumber("۲۴.۵۳۷۳۸")).toBe(LAT);
  });

  it("reads a degree mark", () => {
    expect(coordinateNumber("24.53738°")).toBe(LAT);
    expect(coordinateNumber("24.53738º")).toBe(LAT);
  });

  it("reads a thousands separator where the grouping is real", () => {
    expect(coordinateNumber("1,234.5")).toBe(1234.5);
  });
});

describe("coordinateNumber — compass letters", () => {
  /**
   * The letter was previously stripped and its meaning thrown away, so
   * `"24.53738 S"` read as the northern hemisphere. It is a sign now.
   */
  it("takes N and E as positive and S and W as negative", () => {
    expect(coordinateNumber("24.53738N")).toBe(LAT);
    expect(coordinateNumber("46.64555 E")).toBe(LNG);
    expect(coordinateNumber("24.53738 S")).toBe(-LAT);
    expect(coordinateNumber("46.64555W")).toBe(-LNG);
    expect(coordinateNumber("n24.53738")).toBe(LAT);
    expect(coordinateNumber("s 24.53738")).toBe(-LAT);
  });

  it("refuses a letter that contradicts an explicit sign", () => {
    expect(coordinateNumber("-24.53738S")).toBeNull();
    expect(coordinateNumber("S-24.53738")).toBeNull();
  });

  it("refuses two letters, or a letter that is not a compass point", () => {
    expect(coordinateNumber("N24.53738S")).toBeNull();
    expect(coordinateNumber("24.53738X")).toBeNull();
    expect(coordinateNumber("lat 24.53738")).toBeNull();
  });
});

describe("coordinateNumber — what it refuses", () => {
  it("refuses blank and nothing", () => {
    expect(coordinateNumber("")).toBeNull();
    expect(coordinateNumber("   ")).toBeNull();
    expect(coordinateNumber(null)).toBeNull();
    expect(coordinateNumber(undefined)).toBeNull();
    expect(coordinateNumber(`${RLM}${LRM}`)).toBeNull();
  });

  /**
   * The important refusals. The previous reader stripped every character that
   * was not a digit, a dot or a minus, which turned each of these into a
   * confident, wrong number — 245, 245 and 245373 respectively.
   */
  it("refuses a value it would have to guess at", () => {
    expect(coordinateNumber("24,5")).toBeNull();
    expect(coordinateNumber("near 24.5")).toBeNull();
    expect(coordinateNumber("24.5.373")).toBeNull();
    expect(coordinateNumber("24-53738")).toBeNull();
    expect(coordinateNumber("-")).toBeNull();
    expect(coordinateNumber(".")).toBeNull();
    expect(coordinateNumber("NaN")).toBeNull();
    expect(coordinateNumber("Infinity")).toBeNull();
    expect(coordinateNumber("1e3")).toBeNull();
  });

  it("refuses anything that is not a number or a string", () => {
    expect(coordinateNumber({ lat: 24 })).toBeNull();
    expect(coordinateNumber([24.5])).toBeNull();
    expect(coordinateNumber(true)).toBeNull();
    expect(coordinateNumber(Number.NaN)).toBeNull();
  });
});

describe("the pair the form verifies", () => {
  it("verifies a pasted pair with a stray character on either half", () => {
    const { point, outOfRange } = parseCoordinatePair(`${RLM}24.53738, `, "46.64555\n");
    expect(outOfRange).toBe(false);
    expect(point).toEqual({ lat: LAT, lng: LNG });
  });

  it("still refuses a swapped pair rather than placing it in the ocean", () => {
    expect(parseCoordinatePair("46.64555,", " 24.53738").outOfRange).toBe(true);
  });
});

/**
 * The two readers that used to disagree, asked the same question.
 *
 * `validateAlShrouqOrderFields` reported the latitude *missing* at the same
 * moment the form showed **Verified location** over it. Both now go through
 * `coordinateNumber`, so there is one answer.
 */
describe("the AlShrouq field check agrees with the form", () => {
  const fields = (latitude: string, longitude: string) => ({
    deliveryType: "AlShrouq",
    customerName: "Ahmed",
    customerPhone: "0500000000",
    customerLocation: "https://maps.app.goo.gl/AAA",
    latitude,
    longitude,
  });

  it("accepts every shape a paste produces", () => {
    for (const lat of [
      "24.53738",
      " 24.53738 ",
      "24.53738,",
      "24.53738\n",
      `${RLM}24.53738${LRM}`,
      "24.53738N",
    ]) {
      expect(validateAlShrouqOrderFields(fields(lat, "46.64555"))).toEqual([]);
    }
  });

  it("names the coordinate that is out of range rather than letting it save", () => {
    expect(validateAlShrouqOrderFields(fields("95", "46.64555")).map((i) => i.field)).toEqual([
      "customer_lat",
    ]);
    expect(validateAlShrouqOrderFields(fields("24.53738", "200")).map((i) => i.field)).toEqual([
      "customer_lng",
    ]);
    expect(validateAlShrouqOrderFields(fields("-91", "-181")).map((i) => i.field)).toEqual([
      "customer_lat",
      "customer_lng",
    ]);
  });

  it("names one that is not a coordinate at all", () => {
    expect(validateAlShrouqOrderFields(fields("24,5", "46.64555")).map((i) => i.field)).toEqual([
      "customer_lat",
    ]);
  });

  /** Untouched: an ordinary order is never reachable by any of these rules. */
  it("says nothing at all about an order that is not AlShrouq", () => {
    expect(
      validateAlShrouqOrderFields({ ...fields("nonsense", ""), deliveryType: "Pickup" }),
    ).toEqual([]);
  });
});

/**
 * The save, which is where the agent actually hit the wall.
 *
 * The schema is the last gate before the row, and it is now reading with the
 * same function the green line did — so the number that passed validation is the
 * number that is saved, and a value that genuinely is not a coordinate is
 * refused with a sentence a person can act on rather than a `NaN` type error.
 */
describe("the order form saves what it verified", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    order_date: "2026-09-01",
    team: "customer_care" as const,
    order_type: "Cash",
    branch_no: "P0127",
    delivery_type: "AlShrouq",
    invoice_value: "100",
    status: "pending",
    ...over,
  });

  it("saves the same number the form verified, whatever it was pasted as", () => {
    for (const lat of [
      "24.53738",
      " 24.53738 ",
      "24.53738,",
      "24.53738\n",
      `${RLM}24.53738${LRM}`,
      "24.53738 N",
    ]) {
      const parsed = orderFormSchema.parse(order({ alshrouq_lat: lat, alshrouq_lng: "46.64555," }));
      expect(parsed.alshrouq_lat).toBe(LAT);
      expect(parsed.alshrouq_lng).toBe(LNG);
    }
  });

  it("keeps blank meaning blank, so clearing a location is still an edit", () => {
    const parsed = orderFormSchema.parse(order({ alshrouq_lat: "", alshrouq_lng: null }));
    expect(parsed.alshrouq_lat).toBeNull();
    expect(parsed.alshrouq_lng).toBeNull();
  });

  it("refuses a coordinate outside the globe, and says which one", () => {
    const outOfRange = orderFormSchema.safeParse(
      order({ alshrouq_lat: "95", alshrouq_lng: "46.64555" }),
    );
    expect(outOfRange.success).toBe(false);
    expect(outOfRange.error?.issues[0].path).toEqual(["alshrouq_lat"]);
    expect(outOfRange.error?.issues[0].message).toContain("between -90 and 90");
  });

  it("refuses text that is not a coordinate, in words rather than in NaN", () => {
    const nonsense = orderFormSchema.safeParse(
      order({ alshrouq_lat: "24,5", alshrouq_lng: "46.64555" }),
    );
    expect(nonsense.success).toBe(false);
    expect(nonsense.error?.issues[0].message).toContain("decimal degrees");
    // The old failure: an unreadable value became NaN and the message named
    // neither the field nor what was wrong with it.
    expect(nonsense.error?.issues[0].message).not.toContain("NaN");
  });

  /**
   * A coordinate is never silently dropped.
   *
   * Discarding an unreadable latitude would save an AlShrouq order with no
   * delivery point on it and no complaint, which is a quieter version of the
   * same bug.
   */
  it("does not save an order by throwing away the coordinate it could not read", () => {
    const dropped = orderFormSchema.safeParse(
      order({ alshrouq_lat: "somewhere", alshrouq_lng: "46.64555" }),
    );
    expect(dropped.success).toBe(false);
  });
});
