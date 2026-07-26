import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPaginated } from "@/lib/supabase-paginate";
import { queryKeys } from "@/lib/query-keys";
import type { DashboardFilters } from "@/lib/query-keys";

interface UseDashboardExportDataArgs {
  from: string;
  to: string;
  effectiveAgent: string;
  effectiveTeam: string;
  dashFilters: DashboardFilters;
  isAdmin: boolean;
  userId: string | undefined;
}

/**
 * On-demand XLSX export dataset.
 *
 * Legacy full-row aggregation retained ONLY to power the Excel export, and
 * fetched on demand (enabled: false + refetch on Export click) so it no longer
 * pulls every order/complaint on each page load. All on-screen widgets read the
 * focused orders_ / complaints_ RPCs via useDashboardData. Moved verbatim from
 * the route; returns the refetch handle and busy flag the Export button uses.
 */
export function useDashboardExportData({
  from,
  to,
  effectiveAgent,
  effectiveTeam,
  dashFilters,
  isAdmin,
  userId,
}: UseDashboardExportDataArgs) {
  const { refetch: refetchExport, isFetching: exportBusy } = useQuery({
    queryKey: queryKeys.dashboard.exportData({ ...dashFilters, isAdmin, userId }),
    enabled: false,
    queryFn: async () => {
      const buildOrders = () => {
        let qb = supabase
          .from("orders")
          .select(
            "id,order_date,team,agent_id,branch_no,invoice_value,status,order_type,delivery_type,call_center_verified",
          )
          .gte("order_date", from)
          .lte("order_date", to)
          .order("order_date", { ascending: false });
        if (effectiveAgent !== "all") qb = qb.eq("agent_id", effectiveAgent);
        if (effectiveTeam !== "all")
          qb = qb.eq("team", effectiveTeam as "customer_care" | "telesales");
        return qb;
      };

      const buildComplaints = () => {
        let cb = supabase
          .from("complaints" as any)
          .select("id,complaint_date,branch_no,status,agent_id")
          .gte("complaint_date", from)
          .lte("complaint_date", to)
          .order("complaint_date", { ascending: false });
        if (effectiveAgent !== "all") cb = cb.eq("agent_id", effectiveAgent);
        return cb;
      };

      const [orders, { data: branches }, { data: profiles }, complaints] = await Promise.all([
        fetchAllPaginated<any>(buildOrders),
        supabase.from("branches").select("branch_no,city"),
        supabase.from("profiles").select("id,full_name"),
        fetchAllPaginated<any>(buildComplaints),
      ]);
      const cityMap = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      const nameMap = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      const rangeOrders = orders ?? [];
      const cmps = (complaints as any[]) ?? [];

      const num = (v: any) => Number(v ?? 0);
      const sum = (rows: any[]) => rows.reduce((s, o) => s + num(o.invoice_value), 0);
      const completedRows = (rows: any[]) => rows.filter((o) => o.status === "Completed");
      const cash = (rows: any[]) => rows.filter((o: any) => o.order_type === "Cash");
      const was = (rows: any[]) => rows.filter((o: any) => o.order_type === "Wasfaty");
      const verifiedRows = (rows: any[]) => rows.filter((o: any) => o.call_center_verified);

      const monthAll = sum(rangeOrders);
      const monthCompleted = sum(completedRows(rangeOrders));
      const monthCompletedCount = completedRows(rangeOrders).length;
      const completionRate =
        rangeOrders.length > 0 ? (monthCompletedCount / rangeOrders.length) * 100 : 0;

      // Generic aggregation: counts, completed-sales, completed count, completion rate
      const groupAgg = (rows: any[], keyFn: (o: any) => string) => {
        const m: Record<
          string,
          { count: number; sales: number; completed: number; total: number }
        > = {};
        for (const o of rows) {
          const k = keyFn(o) || "—";
          if (!m[k]) m[k] = { count: 0, sales: 0, completed: 0, total: 0 };
          m[k].count += 1;
          m[k].total += num(o.invoice_value);
          if (o.status === "Completed") {
            m[k].sales += num(o.invoice_value);
            m[k].completed += 1;
          }
        }
        return Object.entries(m).map(([name, v]) => ({
          name,
          ...v,
          rate: v.count > 0 ? (v.completed / v.count) * 100 : 0,
        }));
      };

      const byStatus: Record<string, number> = {};
      for (const o of rangeOrders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

      const byDay: Record<string, { date: string; total: number; completed: number }> = {};
      for (const o of rangeOrders) {
        const d = o.order_date;
        if (!byDay[d]) byDay[d] = { date: d.slice(5), total: 0, completed: 0 };
        byDay[d].total += num(o.invoice_value);
        if (o.status === "Completed") byDay[d].completed += num(o.invoice_value);
      }

      // CC verification by agent
      const verifByAgent: Record<
        string,
        {
          name: string;
          total: number;
          verified: number;
          nonVerified: number;
          verifiedValue: number;
          verifiedCount: number;
        }
      > = {};
      for (const o of rangeOrders) {
        const k = o.agent_id ?? "—";
        const name = nameMap.get(o.agent_id) ?? "Unknown";
        if (!verifByAgent[k])
          verifByAgent[k] = {
            name,
            total: 0,
            verified: 0,
            nonVerified: 0,
            verifiedValue: 0,
            verifiedCount: 0,
          };
        verifByAgent[k].total += 1;
        if (o.call_center_verified) {
          verifByAgent[k].verified += 1;
          verifByAgent[k].verifiedCount += 1;
          verifByAgent[k].verifiedValue += num(o.invoice_value);
        } else {
          verifByAgent[k].nonVerified += 1;
        }
      }
      const verifAgentRows = Object.entries(verifByAgent)
        .map(([agentId, r]) => ({
          agentId,
          ...r,
          rate: r.total > 0 ? (r.verified / r.total) * 100 : 0,
        }))
        .sort((a, b) => b.verified - a.verified);
      // Privacy scoping is enforced by RLS ([H4]): non-privileged agents
      // only receive their own order rows from the database, so a client-
      // side filter here would be redundant.

      const totalVerified = verifiedRows(rangeOrders).length;
      const totalNonVerified = rangeOrders.length - totalVerified;
      const totalVerifiedValue = sum(verifiedRows(rangeOrders));

      // Complaints aggregations
      const cmpByBranch: Record<string, { total: number; resolved: number }> = {};
      const cmpByCity: Record<string, { total: number; resolved: number }> = {};
      let cmpResolved = 0,
        cmpInProg = 0;
      for (const c of cmps) {
        const b = c.branch_no ?? "—";
        const city = cityMap.get(c.branch_no) ?? "—";
        if (!cmpByBranch[b]) cmpByBranch[b] = { total: 0, resolved: 0 };
        if (!cmpByCity[city]) cmpByCity[city] = { total: 0, resolved: 0 };
        cmpByBranch[b].total += 1;
        cmpByCity[city].total += 1;
        if (c.status === "Resolved") {
          cmpByBranch[b].resolved += 1;
          cmpByCity[city].resolved += 1;
          cmpResolved += 1;
        } else cmpInProg += 1;
      }
      const cmpBranchRows = Object.entries(cmpByBranch)
        .map(([name, v]) => ({
          name,
          ...v,
          open: v.total - v.resolved,
          rate: v.total > 0 ? (v.resolved / v.total) * 100 : 0,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
      const cmpCityRows = Object.entries(cmpByCity)
        .map(([name, v]) => ({
          name,
          ...v,
          rate: v.total > 0 ? (v.resolved / v.total) * 100 : 0,
        }))
        .sort((a, b) => b.total - a.total);

      const buildStats = (rows: any[]) => {
        const completed = completedRows(rows);
        const pending = rows.filter((o: any) => o.status === "Pending").length;
        const cancelled = rows.filter((o: any) => o.status === "Cancelled").length;
        return {
          totalSales: sum(rows),
          completedSales: sum(completed),
          totalOrders: rows.length,
          completedOrders: completed.length,
          pending,
          cancelled,
          completionRate: rows.length > 0 ? (completed.length / rows.length) * 100 : 0,
        };
      };
      const cashStats = buildStats(cash(rangeOrders));
      const wasStats = buildStats(was(rangeOrders));
      const totalStats = buildStats(rangeOrders);

      return {
        monthAll,
        monthCompleted,
        monthCompletedCount,
        monthTotalCount: rangeOrders.length,
        monthCashSales: cashStats.totalSales,
        monthWasSales: wasStats.totalSales,
        cashStats,
        wasStats,
        totalStats,
        completionRate,
        totalVerified,
        totalNonVerified,
        totalVerifiedValue,
        verifRate: rangeOrders.length > 0 ? (totalVerified / rangeOrders.length) * 100 : 0,
        verifAgentRows: verifAgentRows.slice(0, 12),
        byAgent: groupAgg(rangeOrders, (o) => nameMap.get(o.agent_id) ?? "Unknown")
          .sort((a, b) => b.sales - a.sales)
          .slice(0, 10),
        byTeam: groupAgg(rangeOrders, (o) =>
          o.team === "telesales" ? "Telesales" : "Customer Care",
        ),
        byBranch: groupAgg(rangeOrders, (o) => o.branch_no ?? "—")
          .sort((a, b) => b.sales - a.sales)
          .slice(0, 10),
        byCity: groupAgg(rangeOrders, (o) => cityMap.get(o.branch_no) ?? "—").sort(
          (a, b) => b.sales - a.sales,
        ),
        byDelivery: groupAgg(rangeOrders, (o) => o.delivery_type ?? "—"),
        byDeliveryBranch: (() => {
          const m: Record<string, Record<string, number>> = {};
          for (const o of completedRows(rangeOrders)) {
            const b = o.branch_no ?? "—";
            const label = b;
            const d = o.delivery_type ?? "—";
            if (!m[label]) m[label] = {};
            m[label][d] = (m[label][d] ?? 0) + num(o.invoice_value);
          }
          return m;
        })(),
        byDeliveryCity: (() => {
          const m: Record<string, Record<string, number>> = {};
          for (const o of completedRows(rangeOrders)) {
            const c = cityMap.get(o.branch_no) ?? "—";
            const d = o.delivery_type ?? "—";
            if (!m[c]) m[c] = {};
            m[c][d] = (m[c][d] ?? 0) + num(o.invoice_value);
          }
          return m;
        })(),
        byStatus: Object.entries(byStatus).map(([name, value]) => ({ name, value })),
        pending: byStatus["Pending"] ?? 0,
        cancelled: byStatus["Cancelled"] ?? 0,
        byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
        cmpTotal: cmps.length,
        cmpResolved,
        cmpInProg,
        cmpResolutionRate: cmps.length > 0 ? (cmpResolved / cmps.length) * 100 : 0,
        cmpBranchRows,
        cmpCityRows,
      };
    },
  });

  return { refetchExport, exportBusy };
}
