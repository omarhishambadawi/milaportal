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
