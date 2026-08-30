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
  /** Narrow to the signed-in agent's starred orders. */
  starredOnly: boolean;
  /**
   * Identity of the star set the query was built from — the sorted order ids,
   * joined, and empty whenever `starredOnly` is false.
   *
   * Part of the key because the starred filter is applied as an `id IN (…)`
   * built from that set: starring an order while the filter is on changes which
   * rows the *same* filter selects, and without this the page and its KPI cards
   * would both answer from a cache entry keyed on a set that no longer exists.
   * Empty when the filter is off, so an ordinary toggle of a star never
   * invalidates the unfiltered list.
   */
  starKey: string;
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
    /**
     * One order's AlShrouq dispatch row.
     *
     * Nested under `orders` so the dispatch state is swept by the same
     * `orders.all()` boundary as the rest of the order, and so the card and the
     * timeline — which both need it — read one cache entry rather than racing
     * two queries on the same row.
     */
    dispatch: (orderId: string | undefined) => ["orders", "dispatch", orderId] as const,
    /**
     * The signed-in agent's starred order ids.
     *
     * Keyed by user id so a sign-out/sign-in on a shared machine cannot serve
     * the previous agent's shortlist out of the cache. Nested under `orders`
     * so it is swept by the same `orders.all()` boundary as everything else
     * about an order; the toggle itself does not use that boundary (see
     * `useStarredOrders`), which is what keeps starring an order from
     * re-running the page fetch and the KPI aggregation.
     */
    stars: (userId: string | undefined) => ["orders", "stars", userId] as const,
  },

  dashboard: {
    /** Invalidation boundary — sweeps all 11 dashboard aggregations. */
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
   * Shams Pharmacy MIS reads.
   *
   * Three separate leaves rather than one keyed blob, because they age at very
   * different rates and the server caches them accordingly: a catalog search
   * holds for minutes, branch stock for a minute, an invoice not at all.
   * Nesting them under one root still gives `all()` as a real invalidation
   * boundary if the MIS connection is ever reconfigured.
   */
  shams: {
    all: () => ["shams"] as const,
    /** Catalog search, keyed on the debounced term actually sent. */
    productSearch: (q: string) => ["shams", "product-search", q] as const,
    /** One item's detail + branch stock, fetched together by the server fn. */
    product: (itemCode: string) => ["shams", "product", itemCode] as const,
    /** One item's CRM offer pricing. Separate from `product` because it is a
     *  live price on a 60 s server cache, not catalog reference data. */
    productOffers: (itemCode: string) => ["shams", "product-offers", itemCode] as const,
    /** One document lookup. Branch is part of the identity — document numbers
     *  repeat across warehouses. */
    invoices: (branchCode: string, docNo: string) =>
      ["shams", "invoices", branchCode, docNo] as const,
    /** One part of the branch sweep for a document number. Parts run in
     *  parallel and are cached independently, so a repeat lookup is free. */
    invoiceBranches: (docNo: string, part: number, parts: number) =>
      ["shams", "invoice-branches", docNo, part, parts] as const,
    /**
     * One document at one branch **with** its lines' branch availability — the
     * Orders panel's read.
     *
     * Separate from `invoices` because it is a different payload, not a
     * different copy: both resolve through the same server-side document and
     * stock caches, so holding both keys never costs a second upstream request.
     * `docNo` must be passed zero-stripped, so `22138` and `022138` share one
     * entry the way they share one document.
     */
    invoiceStock: (branchCode: string, docNo: string) =>
      ["shams", "invoice-stock", branchCode, docNo] as const,
    /**
     * One page of one customer's CRM purchase history.
     *
     * Every argument is part of the identity because every one of them changes
     * the upstream request: the same number over a different window, or the
     * same window at a different page size, is a different answer. Paging
     * through and back is then free, which is the point — the server does not
     * cache this read.
     *
     * The mobile number lives in this key and therefore in the browser's query
     * cache, which is memory the agent's own session already holds. It must not
     * travel any further than that: never into the URL, never into a log.
     */
    crmHistory: (mobile: string, fromDate: string, toDate: string, page: number, perPage: number) =>
      ["shams", "crm-history", mobile, fromDate, toDate, page, perPage] as const,
    /**
     * Offer coverage for a set of items, keyed on the set itself.
     *
     * The codes are sorted and joined by the caller so that the same products
     * in a different order are one cache entry rather than two — a re-search
     * that reorders results by relevance must not re-ask the CRM about items it
     * just asked about.
     */
    offerScopes: (itemCodesKey: string) => ["shams", "offer-scopes", itemCodesKey] as const,
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
