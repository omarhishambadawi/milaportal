/**
 * Invoice items ↔ branch stock. Pure, synchronous, no I/O.
 *
 * An invoice line names a product (`itemCode`) and a quantity; `product/stock`
 * reports quantities per branch for one product. Joining them answers the
 * question an agent reconciling an order actually has — *is what this document
 * sold still on the shelf at the branch that sold it* — and the join is a direct
 * one: `ShamsInvoiceItem.itemCode` is the same identifier `product/stock` takes
 * as `itemcode`, and `ShamsBranchStock.branchCode` is the same identifier space
 * as `branches.branch_no` and the document's `Whouse`. No mapping layer exists
 * or is needed (see docs/project.md, "Branch identity — a direct join").
 *
 * ## Four answers, not two
 *
 * The whole reason this is a named type rather than `number | null` is that
 * "none left" and "we could not find out" are different facts, and rendering
 * either as `0` tells an agent something false:
 *
 *   in_stock      the branch is in the stock response with a quantity above zero
 *   out_of_stock  the branch is in the stock response with zero — a real answer
 *   not_found     the MIS knows no such item code; the response was empty
 *   unknown       the lookup failed, or the response did not mention this branch
 *
 * `unknown` is deliberately the fallback for anything unexplained. The stock
 * response covers all 137 branches in the capture, so a branch missing from a
 * *non-empty* response is unaccounted for rather than empty-handed, and saying
 * "unknown" is the honest reading.
 */

import type { ShamsBranchStock, ShamsInvoiceItem } from "./types";

export type StockState = "in_stock" | "out_of_stock" | "not_found" | "unknown";

/** One invoice line, with what the branch that issued it holds now. */
export interface ItemAvailability {
  itemCode: string;
  itemName: string;
  /** Units this document sold. */
  invoiced: number;
  state: StockState;
  /** Units at the branch — `null` whenever the state is not a quantity. */
  quantity: number | null;
  /**
   * What the line was priced and charged at, straight off the document.
   *
   * `unitRate` is the MIS's `Rate` and `lineTotal` its `Item_NetAmt`, falling
   * back to `Amt` — the two money fields a sales line carries. Both are
   * **`null` when the document priced nothing on this line**, which is a real
   * state and not zero: a header-only row, or a line the MIS returned without
   * money, must not be rendered as "0.00 SAR" as though it were free.
   *
   * Carried here rather than re-fetched: the invoice response already holds
   * them and they were simply being dropped at this boundary, so the panel had
   * a quantity and a stock level for a medication and no idea what it cost.
   */
  unitRate: number | null;
  lineTotal: number | null;
}

/**
 * The distinct item codes on a document, in the order they first appear.
 *
 * A document can list the same product on more than one line (a split
 * quantity, a free-of-charge line beside a sold one), and stock is a property of
 * the product, not of the line. Asking once per *code* rather than once per
 * *line* is the difference between one upstream request and three for the same
 * answer. Blank codes are dropped: `product/stock` cannot be asked about them.
 */
export function invoiceItemCodes(items: readonly ShamsInvoiceItem[]): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const item of items) {
    const code = item.itemCode?.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

/**
 * What one branch holds of one product.
 *
 * `rows` is the whole per-branch response for that item; `undefined` means the
 * lookup did not produce one (it failed, or was never made), which is `unknown`
 * rather than zero. An empty array is the MIS's way of saying it has no such
 * item — the API answers `200` with nothing rather than a 404 — so that is
 * `not_found`.
 */
export function branchStockState(
  rows: readonly ShamsBranchStock[] | undefined,
  branchCode: string,
): { state: StockState; quantity: number | null } {
  if (!rows) return { state: "unknown", quantity: null };
  if (rows.length === 0) return { state: "not_found", quantity: null };

  const code = branchCode.trim().toUpperCase();
  const hit = rows.find((row) => row.branchCode.trim().toUpperCase() === code);
  if (!hit) return { state: "unknown", quantity: null };

  return {
    state: hit.quantity > 0 ? "in_stock" : "out_of_stock",
    quantity: hit.quantity,
  };
}

/**
 * Every line of a document, paired with availability at one branch.
 *
 * Lines are kept as they appear rather than collapsed onto their product: the
 * document is the record being reconciled, and merging two lines that the MIS
 * printed separately would misreport it. Repeated codes therefore share one
 * stock answer, which is exactly what `invoiceItemCodes` fetched.
 *
 * A missing entry in `stockByCode` is `unknown`, so a partial result — some
 * items resolved, one lookup failed — renders as itself rather than failing the
 * document.
 */
export function resolveItemAvailability(
  items: readonly ShamsInvoiceItem[],
  stockByCode: ReadonlyMap<string, readonly ShamsBranchStock[]>,
  branchCode: string,
): ItemAvailability[] {
  return items.map((item) => {
    const code = item.itemCode?.trim() ?? "";
    const { state, quantity } = branchStockState(
      code ? stockByCode.get(code) : undefined,
      branchCode,
    );
    return {
      itemCode: item.itemCode,
      itemName: item.itemName,
      invoiced: item.quantity,
      state,
      quantity,
      ...lineMoney(item),
    };
  });
}

/**
 * The money a line carries, or nulls when it carries none.
 *
 * `toMoney` in the normalizer turns an absent or unparseable field into `0`, so
 * zero here is ambiguous — it is both "free of charge" and "the MIS said
 * nothing". Distinguishing them is not possible from one field alone, but it is
 * from the pair: a line the document priced has *something* non-zero across its
 * rate and its total, and a line with neither was not priced at all. So the two
 * travel together — either both figures or neither — and the panel shows a dash
 * rather than inventing `0.00 SAR` for a medication whose price is unknown.
 *
 * `Item_NetAmt` is preferred over `Amt` because it is the figure the MIS totals
 * a document from; `Amt` is the fallback for responses that leave it empty.
 */
function lineMoney(item: ShamsInvoiceItem): {
  unitRate: number | null;
  lineTotal: number | null;
} {
  const total = item.netAmount || item.amount;
  if (!item.unitRate && !total) return { unitRate: null, lineTotal: null };
  return { unitRate: item.unitRate, lineTotal: total };
}
