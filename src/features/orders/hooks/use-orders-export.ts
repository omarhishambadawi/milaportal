import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { CURRENCY, formatOrderNo } from "@/lib/branches";
import { ORDER_EXPORT_COLUMNS } from "../constants";
import { fmtOrderDate } from "../utils";

interface UseOrdersExportArgs {
  from: string;
  to: string;
  canExport: boolean;
  applyFilters: (qb: any) => any;
  namesById: Map<any, any>;
  cities: Map<any, any> | undefined;
}

/**
 * On-demand XLSX export of every row matching the current filter.
 *
 * Moved verbatim from the route: same permission gate, same batched RLS-safe
 * fetch, same column mapping and file name. xlsx stays lazy-loaded to keep it
 * out of the route's initial chunk.
 */
export function useOrdersExport({
  from,
  to,
  canExport,
  applyFilters,
  namesById,
  cities,
}: UseOrdersExportArgs) {
  const exportXlsx = async () => {
    if (!canExport) {
      toast.error("You don't have permission to export reports");
      return;
    }
    toast.info("Preparing export…");
    // Fetch every row that matches the current filter, in batches, respecting RLS.
    const BATCH = 1000;
    const all: any[] = [];
    for (let start = 0; ; start += BATCH) {
      // The workbook's own columns and no others — see ORDER_EXPORT_COLUMNS.
      let qb = supabase.from("orders").select(ORDER_EXPORT_COLUMNS);
      qb = applyFilters(qb);
      qb = qb.order("order_date", { ascending: false }).order("created_at", { ascending: false });
      qb = qb.range(start, start + BATCH - 1);
      const { data, error } = await qb;
      if (error) {
        toast.error(error.message);
        return;
      }
      all.push(...(data ?? []));
      if (!data || data.length < BATCH) break;
    }
    const names = namesById;
    const XLSX = await import("xlsx");
    const xrows = all.map((o: any) => ({
      "Order #": formatOrderNo(o.team, o.display_no),
      Date: fmtOrderDate(o.order_date),
      Team: o.team === "telesales" ? "Telesales" : "Customer Care",
      Agent: names?.get(o.agent_id)?.full_name ?? "",
      "Agent Code": names?.get(o.agent_id)?.agent_code ?? "",
      Customer: o.customer_name,
      "Phone Number": o.customer_phone,
      "Order Type": o.order_type,
      "Branch No.": o.branch_no,
      City: cities?.get(o.branch_no) ?? "",
      "Delivery & Pickup": o.delivery_type,
      "Invoice No.": o.invoice_no,
      [`Order Value (${CURRENCY})`]: o.invoice_value,
      "CC Verified": o.call_center_verified ? "Yes" : "No",
      Notes: o.notes,
      Status: o.status,
    }));
    const ws = XLSX.utils.json_to_sheet(xrows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");
    XLSX.writeFile(wb, `orders_${from}_${to}.xlsx`);
  };

  return { exportXlsx };
}
