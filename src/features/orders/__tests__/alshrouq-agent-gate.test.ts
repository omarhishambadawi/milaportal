/**
 * The temporary gate: agents get AlShrouq as it worked before the integration.
 *
 * While the integration is being checked out it is held to owner and admin.
 * Everyone else sees AlShrouq as one more delivery method — pick it, save, and a
 * person arranges the delivery, exactly as before. No delivery fields, no
 * scheduling, no dispatch panel, and no request to the courier.
 *
 * This file exists because that split is invisible in the types: the same form,
 * the same hook and the same schemas serve both, and the only thing separating
 * them is one boolean threaded through four places. Losing any one of the four
 * would put an agent back in front of a courier intake form — or, worse, refuse
 * their save for coordinates the temporary workflow never asks for.
 *
 * Nothing here is a new rule. `historicalOrderFormSchema` and the skip argument
 * to `submitToAlShrouq` are the existing pre-integration path, reused rather
 * than rebuilt, and `historical-alshrouq.test.ts` already pins what they do.
 * What is pinned here is *who is put on it*.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAdministrator } from "@/lib/auth";
import { ALSHROUQ, DELIVERY_TYPES } from "@/lib/branches";
import { historicalOrderFormSchema, orderFormSchema } from "../schema";
import { buildOrderPayload, type OrderFormState, type PersistedOrder } from "../payload";
import { summarizeInvoices } from "../invoice-verification";

const hook = readFileSync(
  fileURLToPath(new URL("../hooks/use-order-form.ts", import.meta.url)),
  "utf8",
);
const form = readFileSync(
  fileURLToPath(new URL("../components/order-form.tsx", import.meta.url)),
  "utf8",
);

/** An AlShrouq order as the temporary agent workflow leaves it: method only. */
const agentOrder = {
  order_date: "2026-08-21",
  team: "customer_care" as const,
  order_type: "Cash",
  branch_no: "P0001",
  delivery_type: ALSHROUQ,
  invoice_value: "240",
  status: "Pending",
  alshrouq_map_url: null,
  alshrouq_lat: null,
  alshrouq_lng: null,
  alshrouq_payment_type: null,
};

describe("who the integration is offered to", () => {
  it("is owner and admin, and nobody else", () => {
    expect(isAdministrator("owner")).toBe(true);
    expect(isAdministrator("admin")).toBe(true);
    expect(isAdministrator("supervisor")).toBe(false);
    // The two agent roles, per `AppRole`.
    expect(isAdministrator("customer_care")).toBe(false);
    expect(isAdministrator("telesales")).toBe(false);
  });

  it("gates the delivery fields, the scheduling and the dispatch panel on it", () => {
    // The block carrying `AlShrouqDeliveryFields` — the map link, the point, the
    // payment method and the datetime-local hold — and the historical notice.
    const blocks = form.match(
      /\{alshrouqIntegrationEnabled &&\s*\n\s*form\.delivery_type === ALSHROUQ/g,
    );
    expect(blocks).toHaveLength(2);
    // And the panel, which is where refresh, cancel, retry and the historical
    // declaration live.
    expect(form).toMatch(/\{alshrouqIntegrationEnabled &&\s*\n\s*mode === "edit"/);
    // The customer requirement is the courier API's, so it goes with them.
    expect(form).toContain("!isHistoricalAlShrouq && alshrouqIntegrationEnabled");
  });
});

describe("what an agent's save does", () => {
  it("validates against the pre-integration schema", () => {
    // No name, no phone, no location, no payment method — none of which the
    // temporary workflow asks for, and all of which the integration demands.
    expect(historicalOrderFormSchema.safeParse(agentOrder).success).toBe(true);
    expect(orderFormSchema.safeParse(agentOrder).success).toBe(false);
  });

  it("chooses that schema from the gate, not only from the stored row", () => {
    expect(hook).toContain(
      "const skipAlshrouqIntegration = isHistoricalAlShrouq || !alshrouqIntegrationEnabled;",
    );
    expect(hook).toContain(
      "(skipAlshrouqIntegration ? historicalOrderFormSchema : orderFormSchema).parse(",
    );
  });

  it("sends nothing to the courier, on create or on edit", () => {
    // `submitToAlShrouq` returns before the CRM is touched when this is true;
    // `historical-alshrouq.test.ts` pins that half. Both call sites pass it.
    const calls = hook.match(/submitToAlShrouq\([^)]*skipAlshrouqIntegration\)/g);
    expect(calls).toHaveLength(2);
  });
});

describe("every other method", () => {
  it("still offers the same four, under the same stored names", () => {
    expect([...DELIVERY_TYPES]).toEqual([ALSHROUQ, "Store Pickup", "Branch Scooter", "Azman"]);
  });

  it("is untouched by the gate — the same order parses either way", () => {
    for (const method of ["Store Pickup", "Branch Scooter", "Azman"]) {
      const order = { ...agentOrder, delivery_type: method };
      expect(orderFormSchema.safeParse(order).success).toBe(true);
      expect(historicalOrderFormSchema.safeParse(order).success).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The reported failure                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `Could not find the 'alshrouq_scheduled_at' column of 'orders' in the schema
 * cache` — an agent opening an AlShrouq order on the temporary workflow and
 * pressing Update.
 *
 * The gate took the scheduling *control* away and left the *column* in the
 * write. PostgREST rejects the whole statement over a column it cannot resolve,
 * so the order did not save at all — over a null, for a schedule the agent was
 * never offered and could not have set.
 *
 * What is asserted is the serialized body, not the object: `undefined` is how
 * this payload has always meant "leave the column out" (`agent_id`,
 * `call_center_verified`), and it is `JSON.stringify` inside supabase-js that
 * turns that into a statement which does not name the column.
 */
describe("the column an agent's save must not name", () => {
  /** What supabase-js actually puts on the wire. */
  const wire = (payload: Record<string, unknown>, schema: typeof orderFormSchema) =>
    JSON.parse(JSON.stringify(schema.parse(payload)));

  /**
   * An AlShrouq order as an agent has it open on the temporary workflow.
   *
   * The schedule is deliberately *set*: it was hydrated from a row an admin
   * scheduled, so the fix cannot pass merely because the field happens to be
   * blank. The location fields are blank, which is what the legacy workflow
   * leaves them as.
   */
  const scheduled: OrderFormState = {
    order_date: "2026-08-21",
    team: "customer_care",
    order_type: "Cash",
    customer_name: "Sara",
    customer_phone: "0500000000",
    alshrouq_map_url: "",
    alshrouq_lat: "",
    alshrouq_lng: "",
    alshrouq_payment_type: "",
    alshrouq_scheduled_at: "2026-08-22T09:00",
    branch_no: "P0001",
    delivery_type: ALSHROUQ,
    invoice_value: "240",
    notes: "",
    status: "Pending",
    agent_id: "11111111-1111-4111-8111-111111111111",
    call_center_verified: false,
  };
  const unscheduled: OrderFormState = { ...scheduled, alshrouq_scheduled_at: "" };

  const build = (over: Partial<Parameters<typeof buildOrderPayload>[0]> = {}) =>
    buildOrderPayload({
      mode: "edit",
      form: scheduled,
      invoiceNo: "",
      persisted: { delivery_type: ALSHROUQ, status: "Pending" } as PersistedOrder,
      invoices: summarizeInvoices([]),
      canAssign: false,
      canVerify: false,
      ...over,
    });

  it("is left out of the write on the legacy path", () => {
    const body = wire(build({ includeScheduling: false }), historicalOrderFormSchema);
    expect("alshrouq_scheduled_at" in body).toBe(false);
    // And nothing else went with it — this is one column, not the location.
    expect(body.delivery_type).toBe(ALSHROUQ);
    expect(body.customer_name).toBe("Sara");
    expect(body.status).toBe("Pending");
  });

  it("is still written by the integration's own saves", () => {
    const body = wire(build(), historicalOrderFormSchema);
    expect(body.alshrouq_scheduled_at).toBe(new Date("2026-08-22T09:00").toISOString());
  });

  it("is a null, not an omission, when the integration has nothing to hold", () => {
    // Send-on-save. The integration still names the column, because clearing a
    // schedule is a thing it can do and an omission would not do it.
    const body = wire(build({ form: unscheduled }), historicalOrderFormSchema);
    expect("alshrouq_scheduled_at" in body).toBe(true);
    expect(body.alshrouq_scheduled_at).toBeNull();
  });

  it("is the hook that decides, from the same flag as everything else", () => {
    expect(hook).toContain("includeScheduling: !skipAlshrouqIntegration,");
  });
});
