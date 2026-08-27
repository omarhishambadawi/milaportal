/**
 * The coverage check always finishes.
 *
 * ## The incident
 *
 * On the **Create order** confirmation an agent saw, at the same time:
 *
 *     AlShrouq delivery is not available yet
 *       · Checking AlShrouq coverage for this branch…
 *
 * and, below it, the button **Create order + AlShrouq delivery**. The check
 * never resolved. Nothing was going to make it resolve, because there was no
 * request outstanding — it had already failed.
 *
 * ## The cause
 *
 * `useAlShrouqOrder` derived coverage from one thing: whether `options` was
 * present.
 *
 *     if (!options) return { kind: "unknown" };   // renders as "Checking…"
 *
 * `unknown` was therefore *both* "the answer has not arrived yet" and "the
 * answer is never arriving". With `retry: false`, a single failed request — a
 * dropped connection, a session refreshing under the query, a rejected
 * permission check — put the form in the second case wearing the first case's
 * sentence, permanently, until the page was reloaded.
 *
 * The second half was worse and quieter. `alshrouqDeliveryOptions` caught an
 * unreachable CRM and returned **empty lists with no error marker**, which is
 * indistinguishable from a successful read. Resolving any branch against an
 * empty list gives `not_in_crm`, so during a CRM outage every agent was told:
 *
 *     This branch is not in AlShrouq's list, so it cannot be handed over.
 *     Report it to whoever maintains the branch list.
 *
 * A false statement about the branch, and an errand for somebody with no way to
 * fix it. The order page had a field for exactly this — `optionsError`, on
 * `AlShrouqDispatchContext` — which was set on every failure and **read by
 * nothing**.
 *
 * ## The rule these tests hold
 *
 * `unknown` is reachable only while a request is genuinely in flight. Every way
 * the check can end reaches a terminal state, and a check that could not be
 * completed says so instead of blaming the branch.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  alshrouqRequirements,
  branchCoverage,
  coverageAllowsDispatch,
  describeBranchCoverage,
  type AlShrouqOrderInput,
  type BranchCoverage,
} from "../order-requirements";
import { cardCoverage } from "../dispatch-selection";
import { describeApprovalResult } from "../approval";
import { resolveAlShrouqBranch } from "@/lib/shams-crm/alshrouq-branches";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const hook = read("../use-alshrouq-order.ts");
const functions = read("../../../lib/shams.functions.ts");
const config = read("../../../lib/shams-crm/alshrouq-config.server.ts");

const BRANCH_OPTIONS = [
  {
    id: "9999927657247",
    internal_code: "P0127",
    branch_name: "Al Yasmin",
    label: "P0127 | Al Yasmin",
    covered: true,
    note: null,
  },
  {
    id: "9999927657127",
    internal_code: "P0007",
    branch_name: "Al Khaleej",
    label: "P0007 | Al Khaleej",
    covered: false,
    note: "Outside the service area",
  },
];

/** An order that is complete in every respect except the branch's coverage. */
function completeInput(over: Partial<AlShrouqOrderInput> = {}): AlShrouqOrderInput {
  return {
    deliveryType: "AlShrouq",
    customerName: "Test Customer",
    customerPhone: "0500798930",
    mapUrl: "https://maps.google.com/?q=24.71360,46.67530",
    latitude: "24.71360",
    longitude: "46.67530",
    paymentType: "1",
    ...over,
  };
}

/* ------------------------------------------------------------------------- */
/* I — every coverage answer is terminal, and each says a different thing     */
/* ------------------------------------------------------------------------- */

describe("branch coverage reaches a final answer", () => {
  it("resolves a supported branch", () => {
    const coverage = branchCoverage(resolveAlShrouqBranch(BRANCH_OPTIONS, "P0127"));
    expect(coverage.kind).toBe("covered");
    expect(coverageAllowsDispatch(coverage)).toBe(true);
  });

  /** Case matters no more than surrounding space does. */
  it("resolves a supported branch however it is cased", () => {
    expect(branchCoverage(resolveAlShrouqBranch(BRANCH_OPTIONS, " p0127 ")).kind).toBe("covered");
  });

  it("reports an unsupported branch as uncovered, not as an error", () => {
    const coverage = branchCoverage(resolveAlShrouqBranch(BRANCH_OPTIONS, "P0007"));
    expect(coverage.kind).toBe("not_covered");
    expect(coverageAllowsDispatch(coverage)).toBe(false);
    // Names the consequence and the next step, rather than reading as a typo.
    expect(describeBranchCoverage(coverage)).toContain("choose another delivery method");
  });

  it("blocks dispatch on every state except covered", () => {
    const states: BranchCoverage[] = [
      { kind: "not_covered", branchName: null, note: null },
      { kind: "no_branch" },
      { kind: "unlisted", reason: "not_in_crm" },
      { kind: "unlisted", reason: "no_id_published" },
      { kind: "unavailable", errorKind: "timeout" },
      { kind: "unknown" },
    ];
    for (const state of states) expect(coverageAllowsDispatch(state)).toBe(false);
    expect(coverageAllowsDispatch({ kind: "covered", branchName: null })).toBe(true);
  });

  /** Every state has a sentence. A state with none would render as blank. */
  it("has wording for every state", () => {
    const states: BranchCoverage[] = [
      { kind: "covered", branchName: "Al Yasmin" },
      { kind: "not_covered", branchName: "Al Khaleej", note: null },
      { kind: "no_branch" },
      { kind: "unlisted", reason: "not_in_crm" },
      { kind: "unlisted", reason: "no_id_published" },
      { kind: "unavailable", errorKind: "timeout" },
      { kind: "unknown" },
    ];
    for (const state of states)
      expect(describeBranchCoverage(state).trim().length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------- */
/* II — a failed check is not an uncovered branch                            */
/* ------------------------------------------------------------------------- */

describe("a coverage check that could not be completed", () => {
  const unavailable: BranchCoverage = { kind: "unavailable", errorKind: "timeout" };

  /**
   * The distinction the whole fix rests on. `unknown` is the transient state
   * the screen may sit in; `unavailable` is the terminal one it must land on.
   */
  it("is a different state from 'not yet known'", () => {
    expect(describeBranchCoverage(unavailable)).not.toBe(
      describeBranchCoverage({ kind: "unknown" }),
    );
    expect(describeBranchCoverage({ kind: "unknown" })).toContain("Checking");
    expect(describeBranchCoverage(unavailable)).not.toContain("Checking");
  });

  it("never blames the branch or sends the agent to the branch-list maintainer", () => {
    const message = describeBranchCoverage(unavailable);
    expect(message).not.toContain("not in AlShrouq's list");
    expect(message).not.toContain("branch list");
    expect(message).toContain("could not be checked");
  });

  it("still blocks the handover, so a failed check can never dispatch", () => {
    expect(coverageAllowsDispatch(unavailable)).toBe(false);
    const requirements = alshrouqRequirements(completeInput(), unavailable);
    expect(requirements.map((r) => r.field)).toContain("branch_coverage");
  });

  /** The agent is not left with nothing to do: the order itself is still savable. */
  it("points the agent at the path that still works", () => {
    expect(describeBranchCoverage(unavailable)).toContain("order page");
  });
});

/* ------------------------------------------------------------------------- */
/* III — the hook cannot sit in "Checking…" forever                          */
/* ------------------------------------------------------------------------- */

describe("useAlShrouqOrder settles the coverage query", () => {
  /**
   * Source assertions rather than a render: the suite runs in `node` with no
   * DOM by design (see `vitest.config.ts`), and these are the three lines whose
   * absence caused the incident.
   */
  it("treats a rejected query as a terminal failure, not as pending", () => {
    expect(hook).toContain("isError: optionsFailed");
    expect(hook).toContain('if (optionsFailed) return { kind: "unavailable"');
  });

  it("reads the server's error marker rather than an empty branch list", () => {
    expect(hook).toContain("if (options.optionsError)");
  });

  /** The order is what makes it terminal: both failures precede the `!options` line. */
  it("checks both failures before falling back to 'unknown'", () => {
    const failed = hook.indexOf("if (optionsFailed)");
    const marker = hook.indexOf("if (options.optionsError)");
    const unknown = hook.indexOf('if (!options) return { kind: "unknown" }');
    expect(failed).toBeGreaterThan(-1);
    expect(unknown).toBeGreaterThan(-1);
    expect(failed).toBeLessThan(unknown);
    // `optionsError` is read after `!options`, which is what narrows the type —
    // but still before any branch lookup.
    expect(marker).toBeGreaterThan(unknown);
    expect(marker).toBeLessThan(hook.indexOf("resolveAlShrouqBranch(options.branchOptions"));
  });

  /**
   * `retry: false` made one transient failure permanent, with no control on the
   * screen that would ask again. Bounded, because an unbounded retry would hold
   * the line in "Checking…" for as long as the CRM stayed down — the very state
   * being fixed.
   */
  it("retries a transient failure, boundedly", () => {
    expect(hook).toContain("retry: 2");
    // The option itself, not the prose explaining why it changed — the comment
    // above it names the old value on purpose.
    expect(/^\s*retry: false,\s*$/m.test(hook)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* IV — the server reports why, instead of returning a silent empty list      */
/* ------------------------------------------------------------------------- */

describe("alshrouqDeliveryOptions reports an unreachable CRM", () => {
  it("carries optionsError on the create journey's options", () => {
    expect(functions).toContain("optionsError: string | null");
    expect(functions).toContain(
      'optionsError: err instanceof ShamsCrmError ? err.kind : "unknown"',
    );
  });

  it("marks a successful read as having no error", () => {
    expect(functions).toContain("dispatchAvailable, optionsError: null");
  });

  /**
   * A config that parsed but carried no branches is unusable, and concluding
   * "your branch is not in the list" from it is the same misdiagnosis by
   * another route. Raised as `malformed` so it reaches both journeys through
   * the `optionsError` path that already exists.
   */
  it("treats a config with no branches as malformed rather than as no coverage", () => {
    expect(config).toContain("if (value.branchOptions.length === 0)");
    expect(config).toContain('new ShamsCrmError(\n          "malformed"');
  });

  /** A bad read must not be remembered for the cache's five minutes. */
  it("does not cache a malformed config", () => {
    const guard = config.indexOf("if (value.branchOptions.length === 0)");
    const write = config.indexOf("cached = { at: Date.now(), value }");
    expect(guard).toBeLessThan(write);
  });
});

/* ------------------------------------------------------------------------- */
/* V — the order page reads the marker it was already being sent              */
/* ------------------------------------------------------------------------- */

describe("cardCoverage", () => {
  const covered = resolveAlShrouqBranch(BRANCH_OPTIONS, "P0127");

  it("reports a failed CRM read as unavailable rather than as an unlisted branch", () => {
    const coverage = cardCoverage(false, { kind: "unknown" }, undefined, "timeout");
    expect(coverage).toEqual({ kind: "unavailable", errorKind: "timeout" });
  });

  /**
   * The server falls back to `{kind:"unknown", reason:"not_in_crm"}` when the
   * CRM read fails, which is indistinguishable from a real answer. The marker
   * is what tells the two apart, so it must win over that fallback.
   */
  it("prefers the marker over the branch resolution it was given alongside it", () => {
    const fallback = { kind: "unknown", reason: "not_in_crm" } as const;
    expect(cardCoverage(false, { kind: "unknown" }, fallback, "unavailable").kind).toBe(
      "unavailable",
    );
    // Without the marker, the same resolution is still reported as unlisted.
    expect(cardCoverage(false, { kind: "unknown" }, fallback, null).kind).toBe("unlisted");
  });

  it("leaves the existing precedence alone: the form answers while it is answering", () => {
    const formCoverage: BranchCoverage = { kind: "covered", branchName: "Al Yasmin" };
    expect(cardCoverage(true, formCoverage, undefined, "timeout")).toBe(formCoverage);
  });

  it("still resolves the order's own branch when nothing failed", () => {
    expect(cardCoverage(false, { kind: "unknown" }, covered, null).kind).toBe("covered");
  });
});

/* ------------------------------------------------------------------------- */
/* VI — what the agent is told about a refusal                               */
/* ------------------------------------------------------------------------- */

describe("describeApprovalResult on a refusal", () => {
  const rejection = (over: Partial<{ status: number; reason: string | null }> = {}) => ({
    kind: "rejected" as const,
    status: 422,
    message: "ignored — the sentence is composed from `reason`",
    reason: "customer_phone: invalid phone number",
    ...over,
  });

  it("names the reason and the status", () => {
    const { tone, message } = describeApprovalResult(rejection());
    expect(tone).toBe("error");
    expect(message).toContain("customer_phone: invalid phone number");
    expect(message).toContain("422");
  });

  /**
   * The fact an agent must never have to infer, and it stays last so a long
   * reason cannot push it out of the sentence.
   */
  it("still says no courier was sent", () => {
    expect(describeApprovalResult(rejection()).message).toContain("No courier was sent.");
    expect(describeApprovalResult(rejection({ reason: null })).message).toContain(
      "No courier was sent.",
    );
  });

  it("keeps the original wording when the CRM gave no reason", () => {
    const { message } = describeApprovalResult(rejection({ reason: null }));
    expect(message).toContain("AlShrouq refused the delivery");
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("null");
  });

  /** "Order created." still leads, so the create journey reports both outcomes. */
  it("keeps the created lead-in on the create journey", () => {
    const { message } = describeApprovalResult(rejection(), true);
    expect(message.startsWith("Order created. ")).toBe(true);
    expect(message).toContain("No courier was sent.");
  });

  /** A reason arriving without a full stop must not run into the next sentence. */
  it("punctuates a reason that has none", () => {
    const { message } = describeApprovalResult(rejection({ reason: "branch closed" }));
    expect(message).toContain("branch closed. No courier was sent.");
  });

  it("does not double up punctuation on a reason that has some", () => {
    const { message } = describeApprovalResult(rejection({ reason: "Branch closed." }));
    expect(message).toContain("Branch closed. No courier was sent.");
    expect(message).not.toContain("..");
  });

  /**
   * The neighbouring outcomes are untouched by this change, and each must keep
   * saying the one thing it exists to say.
   */
  it("leaves the other outcomes saying what they always said", () => {
    expect(
      describeApprovalResult({ kind: "prepared", payload: {} as any, liveDispatchEnabled: false })
        .message,
    ).toContain("no courier was contacted");
    expect(
      describeApprovalResult({
        kind: "indeterminate",
        operationId: "op-1",
        errorKind: "timeout",
        message: "unknown",
        reconciled: null,
        dispatch: null,
      }).message,
    ).toContain("NOT been sent again");
  });
});
