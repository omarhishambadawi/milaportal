/**
 * Centralized React Query key factory.
 *
 * Why this exists: React Query prefix-matches invalidation keys **element by
 * element**, so `invalidateQueries({ queryKey: ["orders"] })` matches
 * `["orders", "page", …]` but NOT `["orders-page", …]` — `"orders-page"` and
 * `"orders"` are different strings, not a prefix relationship. The codebase had
 * flat, hyphenated keys (`orders-page`, `dashboard-kpis`, `complaint`) and
 * several invalidations written against the entity name (`["orders"]`,
 * `["dashboard"]`). Those calls compiled, ran, matched nothing, and silently
 * left stale data on screen.
 *
 * The rule this file enforces: **the first element is the entity, and every
 * query for that entity nests under it.** That makes `entity.all()` a real
 * invalidation boundary.
 *
 *   queryKeys.orders.all()          →  ["orders"]                    ← sweeps everything below
 *   queryKeys.orders.page(f)        →  ["orders","page",f]
 *   queryKeys.orders.kpi(f)         →  ["orders","kpi",f]
 *   queryKeys.orders.detail(id)     →  ["orders","detail",id]
 *
 * Lookup data (agent/branch dropdowns) deliberately lives under its own
 * `lookups` root rather than under `orders`/`dashboard`. It is reference data
 * that does not change when an order does, so nesting it beneath an entity
 * would make every order write needlessly re-fetch the directory.
 */

/** Filter set identifying an orders list/KPI query. */
export interface OrdersFilters {
  from: string;
  to: string;
  team: string;
  agent: string;
  status: string;
  /** "all" | "delivery" | "pickup" — the Delivery & Pickup filter. */
  fulfillment: string;
  mineOnly: boolean;
  term: string;
  userId: string | undefined;
}

/** Filter set identifying a dashboard aggregation query. */
export interface DashboardFilters {
  from: string;
  to: string;
  agent: string;
  team: string;
}

/** Filter set identifying a complaints list/page query. */
export interface ComplaintsFilters {
  status: string;
  mineOnly: boolean;
  /** Normalized search term (empty when not searching). */
  term: string;
  /** Comma-joined agent ids whose name matched the term — part of the search
   *  identity, since agent-name search resolves to an agent_id filter. */
  agentMatch: string;
  userId: string | undefined;
}

/** Filter set identifying a call-center analytics query. */
export interface CallCenterFilters {
  from: string;
  to: string;
  team: string;
  agentId: string;
  direction: string;
  /** Customer Care only — telesales agents belong to no queue. */
  queue?: string;
}

export const queryKeys = {
  orders: {
    /** Invalidation boundary — sweeps page, kpi, detail and activity. */
    all: () => ["orders"] as const,
    page: (filters: OrdersFilters, page: number, pageSize: number) =>
      ["orders", "page", filters, { page, pageSize }] as const,
    kpi: (filters: OrdersFilters) => ["orders", "kpi", filters] as const,
    detail: (id: string | undefined) => ["orders", "detail", id] as const,
    activity: (orderId: string) => ["orders", "activity", orderId] as const,
  },

  dashboard: {
    /** Invalidation boundary — sweeps all 12 dashboard aggregations. */
    all: () => ["dashboard"] as const,
    kpis: (f: DashboardFilters) => ["dashboard", "kpis", f] as const,
    daily: (f: DashboardFilters) => ["dashboard", "daily", f] as const,
    status: (f: DashboardFilters) => ["dashboard", "status", f] as const,
    teams: (f: DashboardFilters) => ["dashboard", "teams", f] as const,
    agentSales: (f: DashboardFilters) => ["dashboard", "agent-sales", f] as const,
    locations: (f: DashboardFilters) => ["dashboard", "locations", f] as const,
    delivery: (f: DashboardFilters) => ["dashboard", "delivery", f] as const,
    deliveryMatrix: (f: DashboardFilters) => ["dashboard", "delivery-matrix", f] as const,
    verification: (f: DashboardFilters) => ["dashboard", "verification", f] as const,
    complaintsKpis: (f: Omit<DashboardFilters, "team">) =>
      ["dashboard", "complaints-kpis", f] as const,
    complaintsLocations: (f: Omit<DashboardFilters, "team">) =>
      ["dashboard", "complaints-locations", f] as const,
    /** On-demand XLSX dataset. `enabled: false`; fetched via refetch(). */
    exportData: (f: DashboardFilters & { isAdmin: boolean; userId: string | undefined }) =>
      ["dashboard", "export", f] as const,
  },

  complaints: {
    /** Invalidation boundary — sweeps page, detail and activity. */
    all: () => ["complaints"] as const,
    page: (filters: ComplaintsFilters, page: number, pageSize: number) =>
      ["complaints", "page", filters, { page, pageSize }] as const,
    detail: (id: string | undefined) => ["complaints", "detail", id] as const,
    activity: (complaintId: string) => ["complaints", "activity", complaintId] as const,
  },

  branches: {
    /** Invalidation boundary — sweeps the picker, the directory and the import log. */
    all: () => ["branches"] as const,
    /** Branch picker used by the order and complaint forms. */
    list: () => ["branches", "list"] as const,
    /** Full rows for the admin management table. */
    admin: () => ["branches", "admin"] as const,
    /** Every active branch, with every column — the Branch Directory's dataset. */
    directory: () => ["branches", "directory"] as const,
    /** One branch, for the preview panel shown beside a branch picker. */
    preview: (branchNo: string | null) => ["branches", "preview", branchNo] as const,
    /**
     * Import history. Nested under `branches` on purpose: an import IS a branch
     * write, so the single `invalidateQueries(branches.all())` an import already
     * fires refreshes the history table too rather than leaving it one run behind.
     */
    imports: (limit: number) => ["branches", "imports", limit] as const,
    /**
     * Metadata for the newest import that still carries its uploaded workbook.
     * Under `branches` so an import refreshes it: the file just uploaded is the
     * one the download button should hand back next.
     */
    lastImportFile: () => ["branches", "last-import-file"] as const,
  },

  notifications: {
    all: () => ["notifications"] as const,
    list: (userId: string | undefined) => ["notifications", "list", userId] as const,
  },

  adminUsers: {
    all: () => ["admin-users"] as const,
    list: () => ["admin-users", "list"] as const,
    /**
     * Administrative audit trail. Nested under `admin-users` on purpose: every
     * write on that page appends to this log, so the existing
     * `invalidateQueries(adminUsers.all())` in `useUsersMutations` refreshes the
     * log too rather than leaving it a change behind.
     *
     * `targetUserId` is part of the key because the dialog filters to one account;
     * `limit` is, because paging works by growing it (see `adminListActivity`).
     */
    activity: (targetUserId: string | null, limit: number) =>
      ["admin-users", "activity", targetUserId, limit] as const,
  },

  callCenter: {
    all: () => ["call-center"] as const,
    analytics: (f: CallCenterFilters) => ["call-center", "analytics", f] as const,
    realtime: () => ["call-center", "realtime"] as const,
    queues: () => ["call-center", "queues"] as const,
    /**
     * Yeastar's own Call Report for a window. Keyed by window + queue only —
     * the report is queue-scoped and inbound by construction, so the direction
     * and agent filters do not change the response, and including them would
     * refetch the same rows on every toggle.
     */
    callReport: (f: { from: string; to: string; queue: string }) =>
      ["call-center", "call-report", f] as const,
    /**
     * The Abandoned / Missed drill-down for a window.
     *
     * Carries the same filter identity as `analytics` minus the pieces that
     * cannot change which calls are listed (`team` is fixed per dashboard, and
     * the agent search only narrows a table). `kind` is part of the key because
     * abandoned and missed are two different lists off one window.
     */
    unanswered: (f: {
      from: string;
      to: string;
      kind: "abandoned" | "missed";
      agentId: string;
      direction: string;
      queue: string;
    }) => ["call-center", "unanswered", f] as const,
    /**
     * Call Lookup — one customer number over a trailing window.
     *
     * Keyed by the raw number the user typed rather than its normalized form,
     * so two spellings of the same subscriber are two cache entries. That is
     * deliberate: the server echoes back what it matched on, and a cache hit
     * that silently answered a different string than the one in the box would
     * be indistinguishable from a bug.
     */
    lookup: (number: string, days: number) => ["call-center", "lookup", number, days] as const,
  },

  yeastar: {
    all: () => ["yeastar"] as const,
    config: () => ["yeastar", "config"] as const,
  },

  /**
   * Reference/directory data (profiles, roles, branches for dropdowns).
   * Kept off the entity roots on purpose: an order write must not invalidate
   * the agent directory. Each entry keeps its own cache slot, matching the
   * pre-existing separate keys.
   */
  lookups: {
    all: () => ["lookups"] as const,
    ordersAgents: () => ["lookups", "orders-agents"] as const,
    ordersDirectory: () => ["lookups", "orders-directory"] as const,
    dashboardAgents: () => ["lookups", "dashboard-agents"] as const,
    callCenterAgents: () => ["lookups", "call-center-agents"] as const,
  },
} as const;
