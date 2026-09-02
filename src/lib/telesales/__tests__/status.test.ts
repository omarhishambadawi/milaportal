import { describe, expect, it } from "vitest";
import {
  applyOutcome,
  canActOnLead,
  canAssignLead,
  canRecordOutcome,
  computePriority,
  isFollowupDue,
  outcomeFromLegacyAction,
  proposeFollowup,
} from "../status";
import { CONTACT_ACTIVITY_TYPES, OUTCOMES, isContactActivity, outcomesForLeadType } from "../types";

describe("outcomes", () => {
  it("moves the lead where the outcome says", () => {
    expect(applyOutcome("assigned", "no_answer").status).toBe("in_progress");
    expect(applyOutcome("in_progress", "order_created").status).toBe("converted");
    expect(applyOutcome("in_progress", "reschedule").status).toBe("follow_up");
    expect(applyOutcome("new", "wrong_number").status).toBe("closed_unreachable");
  });

  it("insists on a follow-up date where one is meaningless without it", () => {
    expect(applyOutcome("new", "reschedule").requiresFollowup).toBe(true);
    expect(applyOutcome("new", "interested").requiresFollowup).toBe(true);
    expect(applyOutcome("new", "no_answer").requiresFollowup).toBe(false);
    expect(applyOutcome("new", "order_created").requiresFollowup).toBe(false);
  });

  it("counts every recorded outcome as a contact attempt", () => {
    // Including the ones that failed: a contact *rate* whose denominator only
    // counts successful calls is not a rate.
    for (const outcome of OUTCOMES) {
      expect(applyOutcome("new", outcome.key).countsAsAttempt).toBe(true);
    }
  });

  it("distinguishes reaching the customer from merely dialling them", () => {
    expect(applyOutcome("new", "no_answer").connected).toBe(false);
    expect(applyOutcome("new", "wrong_number").connected).toBe(false);
    expect(applyOutcome("new", "no_order").connected).toBe(true);
    expect(applyOutcome("new", "order_created").connected).toBe(true);
  });

  it("does not treat a collected prescription as a lost sale", () => {
    // 728 rows in Wasfaty Aug. Filing these as `closed_lost` would understate
    // the desk's conversion rate on every report that ever runs.
    const dispensed = applyOutcome("new", "dispensed_expired");
    expect(dispensed.status).toBe("closed_duplicate");
    expect(dispensed.connected).toBe(false);
  });

  it("throws on an outcome key nobody defined", () => {
    expect(() => applyOutcome("new", "made_up")).toThrow(/Unknown telesales outcome/);
  });

  it("refuses a second outcome on a closed lead", () => {
    expect(canRecordOutcome("new")).toBe(true);
    expect(canRecordOutcome("follow_up")).toBe(true);
    expect(canRecordOutcome("converted")).toBe(false);
    expect(canRecordOutcome("closed_lost")).toBe(false);
  });

  it("offers the Wasfaty-only outcomes to Wasfaty leads alone", () => {
    const cash = outcomesForLeadType("cash").map((o) => o.key);
    const wasfaty = outcomesForLeadType("wasfaty").map((o) => o.key);
    expect(cash).not.toContain("dispensed_expired");
    expect(cash).not.toContain("low_price");
    expect(wasfaty).toContain("dispensed_expired");
    // `Rejected` appears in the Wasfaty sheets but is a plausible Cash outcome
    // too, so it is offered to both.
    expect(cash).toContain("rejected");
  });
});

describe("ownership — the rule that stops two agents calling one customer", () => {
  const agent = { userId: "agent-1", canWork: true, canManage: false };
  const other = { userId: "agent-2", canWork: true, canManage: false };
  const lead = { userId: "lead-1", canWork: true, canManage: true };

  it("lets an agent claim an unassigned lead", () => {
    const d = canActOnLead(agent, { assigned_to: null, status: "new" });
    expect(d).toEqual({ allowed: true, claims: true });
  });

  it("lets an agent work their own lead without re-claiming it", () => {
    const d = canActOnLead(agent, { assigned_to: "agent-1", status: "in_progress" });
    expect(d).toEqual({ allowed: true, claims: false });
  });

  it("refuses an agent somebody else's lead", () => {
    const d = canActOnLead(other, { assigned_to: "agent-1", status: "in_progress" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/assigned to another agent/);
  });

  it("lets a team lead act on anything", () => {
    expect(canActOnLead(lead, { assigned_to: "agent-1", status: "in_progress" }).allowed).toBe(
      true,
    );
  });

  it("refuses somebody with view-only access", () => {
    const viewer = { userId: "auditor-1", canWork: false, canManage: false };
    const d = canActOnLead(viewer, { assigned_to: null, status: "new" });
    expect(d.allowed).toBe(false);
  });

  it("keeps reassignment a manager action", () => {
    expect(canAssignLead(agent, { assigned_to: "agent-2" })).toBe(false);
    expect(canAssignLead(agent, { assigned_to: null })).toBe(true);
    expect(canAssignLead(lead, { assigned_to: "agent-2" })).toBe(true);
  });
});

describe("follow-up proposals", () => {
  it("uses the product's refill interval after a conversion", () => {
    expect(
      proposeFollowup("2026-09-01", {
        outcomeKey: "order_created",
        refillDays: 28,
        leadType: "cash",
      }).dueOn,
    ).toBe("2026-09-29");
    // A 30-tablet Rybelsus pack.
    expect(
      proposeFollowup("2026-09-01", {
        outcomeKey: "order_created",
        refillDays: 30,
        leadType: "cash",
      }).dueOn,
    ).toBe("2026-10-01");
    // A 14-day FreeStyle Libre sensor.
    expect(
      proposeFollowup("2026-09-01", {
        outcomeKey: "order_created",
        refillDays: 14,
        leadType: "cash",
      }).dueOn,
    ).toBe("2026-09-15");
  });

  it("falls back when the product has no stated interval", () => {
    expect(
      proposeFollowup("2026-09-01", {
        outcomeKey: "order_created",
        refillDays: null,
        leadType: "cash",
      }).dueOn,
    ).toBe("2026-09-04");
  });

  it("proposes tomorrow for a reschedule", () => {
    expect(
      proposeFollowup("2026-09-01", {
        outcomeKey: "reschedule",
        refillDays: null,
        leadType: "cash",
      }).dueOn,
    ).toBe("2026-09-02");
  });

  it("crosses a month boundary", () => {
    expect(
      proposeFollowup("2026-08-31", {
        outcomeKey: "order_created",
        refillDays: 28,
        leadType: "cash",
      }).dueOn,
    ).toBe("2026-09-28");
  });

  it("treats a due date as workable from the day it arrives", () => {
    expect(isFollowupDue("2026-09-01", "2026-09-01")).toBe(true);
    expect(isFollowupDue("2026-08-30", "2026-09-01")).toBe(true);
    expect(isFollowupDue("2026-09-02", "2026-09-01")).toBe(false);
  });
});

describe("priority", () => {
  it("puts an overdue promise above everything else", () => {
    const overdue = computePriority({
      leadType: "cash",
      hasPhone: false,
      followupOverdue: true,
    });
    const fresh = computePriority({ leadType: "wasfaty", hasPhone: true, followupOverdue: false });
    expect(overdue).toBeGreaterThan(fresh);
  });

  it("ranks a shorter window above a longer one", () => {
    const wasfaty = computePriority({
      leadType: "wasfaty",
      hasPhone: true,
      followupOverdue: false,
    });
    const cash = computePriority({ leadType: "cash", hasPhone: true, followupOverdue: false });
    expect(wasfaty).toBeGreaterThan(cash);
  });

  it("ranks a dialable lead above one that needs a portal lookup first", () => {
    expect(
      computePriority({ leadType: "wasfaty", hasPhone: true, followupOverdue: false }),
    ).toBeGreaterThan(
      computePriority({ leadType: "wasfaty", hasPhone: false, followupOverdue: false }),
    );
  });
});

describe("reading the workbooks' Action column", () => {
  it("maps every spelling the three files contain", () => {
    expect(outcomeFromLegacyAction("No Answer or Busy")).toBe("no_answer");
    expect(outcomeFromLegacyAction("Answered - Order Created")).toBe("order_created");
    expect(outcomeFromLegacyAction("Answered - No Order")).toBe("no_order");
    expect(outcomeFromLegacyAction("Reschedule call")).toBe("reschedule");
    expect(outcomeFromLegacyAction("Wrong Number")).toBe("wrong_number");
    expect(outcomeFromLegacyAction("Dispensed / Expired")).toBe("dispensed_expired");
    expect(outcomeFromLegacyAction("Rejected")).toBe("rejected");
    expect(outcomeFromLegacyAction("Low Price")).toBe("low_price");
    expect(outcomeFromLegacyAction("Discontinued")).toBe("not_interested");
  });

  it("collapses the variants that are the same fact spelled four ways", () => {
    // All four appear in the workbooks.
    expect(outcomeFromLegacyAction("Duplicated Lead")).toBe("duplicate");
    expect(outcomeFromLegacyAction("duplicate ")).toBe("duplicate");
    expect(outcomeFromLegacyAction("DUPLICATE")).toBe("duplicate");
    expect(outcomeFromLegacyAction("Duplicate ")).toBe("duplicate");
    // And these two.
    expect(outcomeFromLegacyAction("N/A")).toBe("unavailable");
    expect(outcomeFromLegacyAction("N.A")).toBe("unavailable");
    // And these.
    expect(outcomeFromLegacyAction("wrong number")).toBe("wrong_number");
    expect(outcomeFromLegacyAction("wrong information")).toBe("wrong_number");
  });

  it("returns null for an emptiness rather than inventing an outcome", () => {
    // `"                   "` is a real value in the Retention sheet.
    expect(outcomeFromLegacyAction("                   ")).toBeNull();
    expect(outcomeFromLegacyAction(null)).toBeNull();
    expect(outcomeFromLegacyAction("")).toBeNull();
  });

  it("returns null for an action nobody has seen, so the importer can report it", () => {
    expect(outcomeFromLegacyAction("Escalated to pharmacist")).toBeNull();
  });
});

describe("what counts as contacting the customer", () => {
  it("is a call, and only a call", () => {
    // The rule the "last contacted by" column and the Call Lookup both use.
    expect(isContactActivity("call")).toBe(true);
    // `created` is written by lead generation with no actor at all — 719 of the
    // 727 live activities. Counting it would claim every untouched lead had
    // been contacted by whoever pressed Import.
    expect(isContactActivity("created")).toBe(false);
    expect(isContactActivity("assigned")).toBe(false);
    expect(isContactActivity("reassigned")).toBe(false);
    expect(isContactActivity("note")).toBe(false);
    expect(isContactActivity("followup_scheduled")).toBe(false);
    expect(isContactActivity("phone_added")).toBe(false);
    expect(isContactActivity("closed")).toBe(false);
  });

  it("exposes the rule as data so the trigger and the UI cannot drift", () => {
    expect([...CONTACT_ACTIVITY_TYPES]).toEqual(["call"]);
  });
});
