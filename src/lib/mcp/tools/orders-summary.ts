import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

export default defineTool({
  name: "orders_summary",
  title: "Orders summary",
  description:
    "Aggregate the signed-in user's visible orders in a date range: totals, count by team, count by status, and total invoice value.",
  inputSchema: {
    from: z.string().describe("Start date (YYYY-MM-DD, inclusive)."),
    to: z.string().describe("End date (YYYY-MM-DD, inclusive)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ from, to }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const { data, error } = await supabase
      .from("orders")
      .select("team, status, invoice_value")
      .gte("order_date", from)
      .lte("order_date", to)
      .limit(5000);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const rows = data ?? [];
    const byTeam: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalValue = 0;
    for (const r of rows) {
      const team = String(r.team ?? "unknown");
      const status = String(r.status ?? "unknown");
      byTeam[team] = (byTeam[team] ?? 0) + 1;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      totalValue += Number(r.invoice_value ?? 0);
    }
    const summary = {
      from,
      to,
      total_orders: rows.length,
      total_invoice_value: totalValue,
      by_team: byTeam,
      by_status: byStatus,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
});
