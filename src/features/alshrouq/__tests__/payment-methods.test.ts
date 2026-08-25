/**
 * The payment method, as a person reads it and as an order remembers it.
 *
 * Two defects, one field, and they are not the same defect:
 *
 *   1. **The card printed the id.** "Payment Type: 3". Every screen resolved the
 *      label inline and ended `?? stored`, so whenever the CRM's live option
 *      list was not there — first render, unreachable CRM, no credentials — an
 *      operations screen showed a bare integer.
 *   2. **Reopening an order showed nothing at all.** Handing an order to
 *      AlShrouq writes `payment_type` onto the dispatch row without writing
 *      `orders.alshrouq_payment_type`, which is only written by pressing
 *      **Update order**. Nobody presses it after arranging a delivery, so
 *      production carries dispatched orders whose delivery says `3` and whose
 *      order column says null — and the next person to open one was asked for
 *      the method again.
 *
 * The ids and their names are the PharmacyCRM Desktop's own
 * `_load_local_alshrouq_mapping`, read off the disassembled build. They are a
 * display floor, not a contract: the wire still carries the CRM's integer, and
 * the collect-or-not decision is still made from the live labels.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALSHROUQ_FALLBACK_PAYMENT_OPTIONS,
  alshrouqPaymentLabel,
  alshrouqPaymentOptions,
  resolveAlShrouqPaymentType,
} from "../payment-methods";
import { buildAlshrouqOrderPayload, isPaidPaymentType } from "@/lib/shams-crm/alshrouq-payload";

/** The CRM's live list, as `GET /integrations/alshrouq/config` returns it. */
const LIVE = [
  { id: 1, label: "Cash on Delivery (COD)" },
  { id: 2, label: "Span Machine" },
  { id: 3, label: "Paid" },
];

/* -------------------------------------------------------------------------- */
/* The label                                                                   */
/* -------------------------------------------------------------------------- */

describe("a payment method is shown by name, never by id", () => {
  it.each([
    [1, "Cash on Delivery (COD)", "COD"],
    [2, "Span Machine", "Span Machine"],
    [3, "Paid", "Paid"],
  ])("renders %i as a name containing %s", (id, expected, mustContain) => {
    // With the live list…
    expect(alshrouqPaymentLabel(id, LIVE)).toBe(expected);
    // …and without it, which is the case that was broken.
    expect(alshrouqPaymentLabel(id, [])).toBe(expected);
    expect(alshrouqPaymentLabel(id, [])).toContain(mustContain);
  });

  it.each([1, 2, 3, 4])("never returns the bare id for %i, with no options at all", (id) => {
    for (const options of [undefined, null, []]) {
      const label = alshrouqPaymentLabel(id, options);
      expect(label).not.toBe(String(id));
      expect(label).toBeTruthy();
    }
  });

  it("takes the id as the text a form and a row hold it in", () => {
    // The form holds "3"; `alshrouq_dispatches.payment_type` comes back as a
    // string from one driver and a number from another. All three agree.
    expect(alshrouqPaymentLabel("3", LIVE)).toBe("Paid");
    expect(alshrouqPaymentLabel(" 3 ", LIVE)).toBe("Paid");
    expect(alshrouqPaymentLabel(3, LIVE)).toBe("Paid");
  });

  it("prefers whatever the CRM currently calls the method", () => {
    // The live list is the authority. A deployment that renames a method needs
    // no edit here, which is why no id is written into a component.
    expect(alshrouqPaymentLabel(1, [{ id: 1, label: "Cash on delivery" }])).toBe(
      "Cash on delivery",
    );
  });

  it("names an id it has never heard of rather than printing a quantity", () => {
    expect(alshrouqPaymentLabel(97, LIVE)).toBe("Payment method 97");
  });

  it.each([null, undefined, "", "   ", "abc"])("returns null for %p", (value) => {
    // "Not chosen" is a different sentence from "chosen", and each screen picks
    // its own words for it.
    expect(alshrouqPaymentLabel(value, LIVE)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The picker                                                                  */
/* -------------------------------------------------------------------------- */

describe("the picker always has an item for the value it is given", () => {
  it("offers the CRM's list when there is one", () => {
    // Never the union: offering a method this deployment does not have would
    // produce an order the payload builder then refuses by id.
    expect(alshrouqPaymentOptions(LIVE)).toBe(LIVE);
  });

  it("offers the known methods while the CRM has not answered", () => {
    /*
     * A Radix `Select` whose value matches none of its items renders its
     * *placeholder*, so a reopened order carrying method 3 read "How does the
     * customer pay?" — an answered field presenting itself as unanswered.
     */
    for (const empty of [undefined, null, []]) {
      const options = alshrouqPaymentOptions(empty);
      expect(options.length).toBeGreaterThan(0);
      expect(options.map((o) => o.id)).toContain(3);
    }
  });

  it("carries the ids the Desktop build publishes", () => {
    expect(ALSHROUQ_FALLBACK_PAYMENT_OPTIONS.map((o) => o.id)).toEqual([1, 2, 3, 4]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reopening an order                                                          */
/* -------------------------------------------------------------------------- */

describe("reopening an order keeps the payment method it was dispatched with", () => {
  it("uses the dispatch row when the order's own column was never written", () => {
    // The reported bug, exactly: form blank (hydration from a null column), the
    // order column null, and the delivery holding 3.
    expect(resolveAlShrouqPaymentType("", null, 3)).toBe("3");
    expect(alshrouqPaymentLabel(resolveAlShrouqPaymentType("", null, 3), LIVE)).toBe("Paid");
  });

  it.each([
    [1, "Cash on Delivery (COD)"],
    [2, "Span Machine"],
    [3, "Paid"],
  ])("reopens a delivery created with %i showing %s", (id, label) => {
    expect(alshrouqPaymentLabel(resolveAlShrouqPaymentType("", null, id), LIVE)).toBe(label);
  });

  it("prefers the order's own column over the dispatch row", () => {
    // The order is the ordinary answer. The dispatch is the repair.
    expect(resolveAlShrouqPaymentType("", 2, 3)).toBe("2");
  });

  it("never overrules what the agent has on screen", () => {
    // Changing the method still works: a form value wins over both persisted
    // sources, so a fresh choice is never replaced by an older fact.
    expect(resolveAlShrouqPaymentType("1", 2, 3)).toBe("1");
  });

  it("invents nothing when no source has a method", () => {
    // Not a frontend default. A new order still has to be answered.
    expect(resolveAlShrouqPaymentType("", null, null)).toBe("");
    expect(resolveAlShrouqPaymentType(undefined, undefined, undefined)).toBe("");
  });

  it.each(["", "   ", null, undefined])("treats %p in the form as absent", (blank) => {
    expect(resolveAlShrouqPaymentType(blank, 3, null)).toBe("3");
  });

  it("accepts the string and number shapes the two sources arrive in", () => {
    // `orders.alshrouq_payment_type` is an integer column; the dispatch row's
    // is read back as text. Neither shape may change the answer.
    expect(resolveAlShrouqPaymentType("", "3", null)).toBe("3");
    expect(resolveAlShrouqPaymentType("", null, "2")).toBe("2");
  });
});

/* -------------------------------------------------------------------------- */
/* And none of it reaches the wire                                             */
/* -------------------------------------------------------------------------- */

describe("this is presentation, and the payload is unchanged", () => {
  const ORDER = {
    display_no: "#9540",
    customer_name: "Ahmed",
    customer_phone: "0500000000",
    invoice_value: 239.25,
  };
  const CONTEXT = {
    alshrouqBranchId: "9999927657247",
    paymentOptionIds: [1, 2, 3],
    paidPaymentTypeIds: [3],
  };

  it("still sends the CRM's integer, not a label", () => {
    const built = buildAlshrouqOrderPayload({ ...ORDER, alshrouq_payment_type: 3 }, CONTEXT);
    expect(built.ok && built.payload.payment_type).toBe(3);
  });

  it.each([
    [1, 239.25, "COD collects the entered value"],
    [2, 239.25, "Span Machine collects the entered value"],
    [3, 0, "Paid collects nothing"],
  ])("keeps the collect rule for method %i", (id, expected) => {
    const built = buildAlshrouqOrderPayload({ ...ORDER, alshrouq_payment_type: id }, CONTEXT);
    expect(built.ok && built.payload.value).toBe(expected);
  });

  it("puts the collect amount under `value`, and never under `order_value`", () => {
    /*
     * The regression guard for the fix in 807cd8f. The GET returns this figure
     * as `order_value`; the POST takes it as `value`, and sending the read
     * model's name is silent data loss — the endpoint ignores the unrecognised
     * key, returns 2xx, and stores a collect amount of 0.
     */
    const built = buildAlshrouqOrderPayload({ ...ORDER, alshrouq_payment_type: 1 }, CONTEXT);
    expect(built.ok && "value" in built.payload).toBe(true);
    expect(built.ok && "order_value" in built.payload).toBe(false);
  });

  it("still decides prepaid from the live labels, not from an id written down here", () => {
    // The fallback table exists for display only. Renaming a label in it must
    // not be able to change who is asked to pay.
    expect(isPaidPaymentType(3, LIVE)).toBe(true);
    expect(isPaidPaymentType(3, [])).toBe(false);
    // `AlshrouqPay` is a different method — the courier collects through
    // AlShrouq's own wallet — and must never be read as already paid.
    expect(isPaidPaymentType(4, [{ id: 4, label: "AlshrouqPay" }])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The wiring                                                                  */
/*                                                                             */
/* Asserted on the source, because both defects were wiring: the label rule and */
/* the persistence rule were each correct somewhere and simply not reached from */
/* the screen that needed them.                                                */
/* -------------------------------------------------------------------------- */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("every screen asks the one helper", () => {
  const card = read("../components/dispatch-section.tsx");
  const requirements = read("../components/order-requirements-section.tsx");
  const hook = read("../use-alshrouq-order.ts");
  const orderForm = read("../../orders/components/order-form.tsx");

  it("resolves the label through `alshrouqPaymentLabel` and not inline", () => {
    for (const source of [card, hook]) {
      expect(source).toContain("alshrouqPaymentLabel(");
    }
  });

  it("has no `?? stored`-shaped fallback left anywhere", () => {
    /*
     * The exact shape that printed "3": find the option, and if there is no
     * option, show the id. Two files did it, identically, and both were one
     * unreachable CRM away from putting an integer on an operations screen.
     *
     * Comments are stripped first — the files now *explain* the old shape, and
     * a test that could not tell an explanation from the code it describes
     * would fail on its own documentation.
     */
    const code = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const source of [card, requirements, hook]) {
      expect(code(source)).not.toMatch(/\?\?\s*(stored|paymentType)\b/);
    }
  });

  it("gives the picker a list that always contains the stored value", () => {
    expect(requirements).toContain("alshrouqPaymentOptions(options.paymentOptions)");
  });

  it("feeds the order form's AlShrouq half the resolved method", () => {
    // Not `form.alshrouq_payment_type` directly: that is blank on the first
    // render of every load, and null in the column on a dispatched order.
    expect(orderForm).toContain("resolveAlShrouqPaymentType(");
    expect(orderForm).toContain("dispatchState?.current?.payment_type");
    expect(orderForm).toContain("alshrouq_payment_type: alshrouqPaymentType,");
  });

  it("writes the resolved method back only while the form has none", () => {
    // The guard that stops it overruling a newer choice.
    expect(orderForm).toContain("f.alshrouq_payment_type.trim()");
  });
});
