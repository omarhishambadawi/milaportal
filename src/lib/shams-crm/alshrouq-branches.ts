/**
 * Which AlShrouq branch a Portal branch is. Pure, no I/O.
 *
 * The Portal knows a branch as `P0217`. AlShrouq knows it as `9999927657247`.
 * Something has to join the two, and the only thing that may is the CRM's own
 * `GET /integrations/alshrouq/config`, which publishes `branch_options` live.
 *
 * **The mapping is deliberately not stored here.** A shipped copy of it is what
 * the reverted integration did — it froze 137 rows into a migration, and a
 * frozen copy cannot express `covered`, the flag that marks the 18 branches
 * AlShrouq does not serve. (For the record: the workbook's ids were checked
 * against the CRM's live list and were 136/136 correct. The migration comment
 * claiming otherwise is wrong. Freezing it was still the wrong call, because
 * correct-today is not the same as correct.)
 *
 * So this module takes the CRM's list as an argument and answers one question
 * about it. It holds no ids of its own.
 */

/** One entry of the CRM's `branch_options`, as confirmed from the live config. */
export interface AlShrouqBranchOption {
  /** The AlShrouq id. A 13-digit numeric string. */
  id: string | null;
  /** The Shams branch code — `P0217`. What `orders.branch_no` holds. */
  internal_code: string | null;
  branch_name: string | null;
  label: string | null;
  /** False for the branches AlShrouq does not serve. */
  covered: boolean;
  note: string | null;
}

export type AlShrouqBranchResolution =
  /** Dispatchable. `branchId` is what the payload's `branch_id` takes. */
  | { kind: "resolved"; branchId: string; branchName: string | null }
  /** Known to the CRM, but AlShrouq does not serve it. Not an error. */
  | { kind: "not_covered"; branchName: string | null; note: string | null }
  /** The CRM's list does not contain this code, or there is no code to look up. */
  | { kind: "unknown"; reason: "no_branch_on_order" | "not_in_crm" | "no_id_published" };

/** Codes are compared trimmed and case-insensitively; `p0217` is `P0217`. */
function key(code: string | null | undefined): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

/**
 * Resolve one branch, or say precisely why it cannot be.
 *
 * The three failure modes are kept apart on purpose, because they are three
 * different conversations with an agent: "this order has no branch" is a
 * data-entry fix, "AlShrouq does not cover this branch" is not fixable at all
 * and the order must go another way, and "the CRM does not list this branch" is
 * something for whoever maintains the CRM. Collapsing them into `null` would
 * make every one of them read as a bug.
 */
export function resolveAlShrouqBranch(
  options: readonly AlShrouqBranchOption[],
  branchNo: string | null | undefined,
): AlShrouqBranchResolution {
  const wanted = key(branchNo);
  if (wanted.length === 0) return { kind: "unknown", reason: "no_branch_on_order" };

  const hit = options.find((o) => key(o.internal_code) === wanted);
  if (!hit) return { kind: "unknown", reason: "not_in_crm" };

  // Checked before the id: an uncovered branch is a real answer, and reporting
  // it as a missing id would send someone looking for a data problem that is
  // not there.
  if (!hit.covered) {
    return { kind: "not_covered", branchName: hit.branch_name, note: hit.note };
  }

  const branchId = typeof hit.id === "string" ? hit.id.trim() : "";
  if (branchId.length === 0) return { kind: "unknown", reason: "no_id_published" };

  return { kind: "resolved", branchId, branchName: hit.branch_name };
}
