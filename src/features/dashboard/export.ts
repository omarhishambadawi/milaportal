// xlsx is lazy-loaded inside exportDashboard() to keep it out of the Dashboard
// route's initial chunk — Dashboard is the default landing route for most roles,
// and the library is only needed once the user clicks Export.

/**
 * Build and download the multi-sheet Dashboard XLSX from the on-demand export
 * dataset (see `useDashboardExportData`). Pure output — no data fetching here.
 */
export async function exportDashboard(
  data: any,
  ctx: { from: string; to: string; agentLabel: string | null; teamLabel: string },
) {
  if (!data) return;
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const teamLbl = ctx.teamLabel === "customer_care" ? "Customer Care" : ctx.teamLabel === "telesales" ? "Telesales" : "All Teams";
  const summary = [
    ["MilaServ Portal — Dashboard Export"],
    ["Period", `${ctx.from} to ${ctx.to}`],
    ["Team", teamLbl],
    ["Agent", ctx.agentLabel ?? "All agents"],
    [],
    ["KPI", "Value"],
    ["Total orders", data.monthTotalCount],
    ["Completed orders", data.monthCompletedCount],
    ["Pending", data.pending],
    ["Cancelled", data.cancelled],
    ["Completion rate (%)", Number(data.completionRate.toFixed(2))],
    ["Total sales", data.monthAll],
    ["Completed sales", data.monthCompleted],
    ["Cash sales", data.monthCashSales],
    ["Wasfaty sales", data.monthWasSales],
    ["Avg order value", data.monthTotalCount > 0 ? data.monthAll / data.monthTotalCount : 0],
    ["Verified invoices", data.totalVerified],
    ["Non-verified", data.totalNonVerified],
    ["Verification rate (%)", Number(data.verifRate.toFixed(2))],
    ["Verified value", data.totalVerifiedValue],
    [],
    ["Complaints", ""],
    ["Total complaints", data.cmpTotal],
    ["In progress", data.cmpInProg],
    ["Resolved", data.cmpResolved],
    ["Resolution rate (%)", Number(data.cmpResolutionRate.toFixed(2))],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");

  const sheet = (name: string, rows: any[]) => {
    if (!rows || rows.length === 0) return;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  };
  sheet("Daily Sales", (data.byDay ?? []).map((d: any) => ({ Date: d.date, "All Sales": d.total, "Completed Sales": d.completed })));
  sheet("By Status", (data.byStatus ?? []).map((s: any) => ({ Status: s.name, Count: s.value })));
  sheet("By Team", (data.byTeam ?? []).map((t: any) => ({ Team: t.name, Orders: t.count, "Completed Sales": t.sales, "Completion Rate %": Number(t.rate.toFixed(1)) })));
  sheet("By Agent", (data.byAgent ?? []).map((a: any) => ({ Agent: a.name, Orders: a.count, "Completed Sales": a.sales, "Completion Rate %": Number(a.rate.toFixed(1)) })));
  sheet("By Branch", (data.byBranch ?? []).map((b: any) => ({ Branch: b.name, Orders: b.count, "Completed Sales": b.sales, "Completion Rate %": Number(b.rate.toFixed(1)) })));
  sheet("By City", (data.byCity ?? []).map((c: any) => ({ City: c.name, Orders: c.count, "Completed Sales": c.sales, "Completion Rate %": Number(c.rate.toFixed(1)) })));
  sheet("Delivery Methods", (data.byDelivery ?? []).map((d: any) => ({ Method: d.name, Orders: d.count, "Completed Sales": d.sales, "Completion Rate %": Number(d.rate.toFixed(1)) })));
  sheet("CC Verification by Agent", (data.verifAgentRows ?? []).map((r: any) => ({ Agent: r.name, "Total Orders": r.total, Verified: r.verified, "Non-verified": r.nonVerified, "Rate %": Number(r.rate.toFixed(1)), "Verified Value": r.verifiedValue })));
  sheet("Complaints by Branch", (data.cmpBranchRows ?? []).map((r: any) => ({ Branch: r.name, Total: r.total, Resolved: r.resolved, Open: r.open, "Resolution Rate %": Number(r.rate.toFixed(1)) })));
  sheet("Complaints by City", (data.cmpCityRows ?? []).map((r: any) => ({ City: r.name, Total: r.total, "Resolution Rate %": Number(r.rate.toFixed(1)) })));

  XLSX.writeFile(wb, `dashboard_${ctx.from}_${ctx.to}.xlsx`);
}
