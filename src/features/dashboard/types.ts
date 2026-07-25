/** Dashboard-local types shared across its hooks and components. */

/** One row of the `orders_kpis` RPC (per cash/wasfaty/total bucket). */
export type KpiRow = {
  bucket: string;
  total_sales: number;
  completed_sales: number;
  order_count: number;
  completed_count: number;
  pending_count: number;
  cancelled_count: number;
  completion_rate: number;
};

/** Normalized KPI figures a `DashKpiCard` renders. */
export type DashKpiStats = {
  totalSales: number;
  completedSales: number;
  totalOrders: number;
  completedOrders: number;
  pending: number;
  cancelled: number;
  completionRate: number;
};
