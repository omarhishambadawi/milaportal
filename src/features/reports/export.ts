import type { useMonthlyReport } from "./hooks/use-monthly-report";

/**
 * The Monthly Report as a workbook.
 *
 * Same architecture as the Dashboard's own export (`features/dashboard/export.ts`):
 * `xlsx` is imported inside the function so the writer — the second largest
 * thing this app ships after Recharts — stays out of the route's chunk until
 * somebody clicks Export, and the function is pure output. It fetches nothing
 * and computes nothing; every figure is handed in already derived by
 * `useMonthlyReport`, which is what stops the workbook from becoming a third
 * opinion about the month alongside the page and the dashboard.
 *
 * ---------------------------------------------------------------------------
 * On the brand identity
 * ---------------------------------------------------------------------------
 * The workbook carries the report's structure — titled sections, a blank row
 * between them, header rows, per-cell currency and percentage number formats,
 * and column widths sized to the longest value in each column. It does **not**
 * carry the brand's fills and font colours, and cannot: cell styling and
 * embedded charts are features of SheetJS Pro, and the community build this
 * project depends on drops a `.s` style object on write without complaint.
 * Adding a second spreadsheet library to colour a header would put a parallel
 * writer into the bundle for decoration, which the brief rules out. The charts
 * live in the PDF, which is the artefact meant to be looked at; this is the one
 * meant to be filtered, sorted and pivoted.
 */

type MonthlyData = ReturnType<typeof useMonthlyReport>;

/**
 * Number formats, applied per cell rather than per column.
 *
 * Per column is the obvious shortcut and the wrong one here: these sheets stack
 * several tables under one set of column letters, so column B is money in the
 * KPI block and an order count two tables further down. A count rendered under
 * a currency format reads as money it is not.
 */
const SAR = '#,##0.00 "SAR"';
const PCT = '0.0"%"';
const INT = "#,##0";

/** A pre-formatted numeric cell. `aoa_to_sheet` takes cell objects as they are. */
interface FormattedCell {
  v: number;
  t: "n";
  z: string;
}

type Cell = string | number | null | FormattedCell;
type Row = Cell[];

const sar = (value: number): FormattedCell => ({ v: value, t: "n", z: SAR });
const int = (value: number): FormattedCell => ({ v: value, t: "n", z: INT });
/** Percentages arrive as 0–100, not 0–1, so the format carries the sign itself. */
const pct = (value: number | null): Cell => (value == null ? null : { v: value, t: "n", z: PCT });

/** A section heading, then its header row — the shape every block below uses. */
function section(title: string, header: string[]): Row[] {
  return [[title], header];
}

export async function exportMonthlyReport(
  data: MonthlyData,
  ctx: { from: string; to: string; label: string },
) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  const { summary, teams, orderTypes, fulfillment, trendHighlights, calls, callCenter } = data;
  const [customerCare, telesales] = teams.rows;
  const notCompleted = summary.totalOrders - summary.completedOrders;

  /** Column widths, in characters. Sized so nothing renders as `#####`. */
  const widths = (...chars: number[]) => chars.map((wch) => ({ wch }));

  const sheet = (name: string, rows: Row[], cols: { wch: number }[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows as unknown[][]);
    ws["!cols"] = cols;
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  };

  /* ---------------------------------------------------------------------- */
  /* Sheet 1 — Monthly Report                                                */
  /* ---------------------------------------------------------------------- */

  const overview: Row[] = [
    ["MilaServ Portal — Monthly Report"],
    ["Reporting period", ctx.label],
    ["Date range", `${ctx.from} to ${ctx.to}`],
    ["Generated", new Date().toISOString().slice(0, 10)],
    [],
    ...section("KPI SUMMARY", ["Metric", "Value"]),
    ["Total revenue", sar(summary.totalSales)],
    ["Completed revenue", sar(summary.completedSales)],
    ["Total orders", int(summary.totalOrders)],
    ["Completed orders", int(summary.completedOrders)],
    ["Overall completion rate", pct(summary.completionRate)],
    ["Average order value", sar(summary.averageOrderValue)],
    ["Revenue lost (non-completed)", sar(summary.revenueLost)],
    ["Orders not completed", int(notCompleted)],
    ["Top city by revenue", data.topCity?.name ?? "—"],
    ["Top city revenue", sar(data.topCity?.sales ?? 0)],
    [],
    ...section("CUSTOMER CARE — COMPLETED PERFORMANCE", ["Metric", "Value"]),
    ["Completed revenue", sar(customerCare.completedSales)],
    ["Completed orders", int(customerCare.completedOrders)],
    ["Completion rate", pct(customerCare.completionRate)],
    [],
    ...section("TELESALES — COMPLETED PERFORMANCE", ["Metric", "Value"]),
    ["Completed revenue", sar(telesales.completedSales)],
    ["Completed orders", int(telesales.completedOrders)],
    ["Completion rate", pct(telesales.completionRate)],
    [],
    ...section("TEAM PERFORMANCE — DETAIL", [
      "Team",
      "Orders",
      "Completed",
      "Completion rate",
      "Total revenue",
      "Completed revenue",
      "Cash",
      "Wasfaty",
      "Average order value",
      "Share of completed revenue",
    ]),
    ...[...teams.rows, teams.total].map(
      (row): Row => [
        row.team,
        int(row.orders),
        int(row.completedOrders),
        pct(row.completionRate),
        sar(row.totalSales),
        sar(row.completedSales),
        sar(row.cashSales),
        sar(row.wasfatySales),
        sar(row.averageOrderValue),
        pct(row.contribution),
      ],
    ),
  ];

  sheet("Monthly Report", overview, widths(34, 20, 14, 16, 20, 22, 16, 16, 20, 26));

  /* ---------------------------------------------------------------------- */
  /* Sheet 2 — Revenue Analysis                                              */
  /* ---------------------------------------------------------------------- */

  const revenue: Row[] = [
    [`Revenue Analysis — ${ctx.label}`],
    [],
    ...section("REVENUE BY TEAM", ["Team", "Total revenue", "Completed revenue", "Revenue lost"]),
    ...data.teamRevenue.map(
      (row): Row => [row.name, sar(row.total), sar(row.completed), sar(row.total - row.completed)],
    ),
    [],
    ...section("DAILY REVENUE TREND", ["Day", "Total revenue", "Completed revenue"]),
    ...data.trend.map((point): Row => [point.date, sar(point.total), sar(point.completed)]),
    [],
    ...section("REVENUE BY CITY", ["City", "Completed revenue"]),
    ...data.cities.map((city): Row => [city.name, sar(city.sales)]),
    [],
    ...section("REVENUE BY BRANCH", ["Branch", "Completed revenue"]),
    ...data.branches.map((branch): Row => [branch.name, sar(branch.sales)]),
    [],
    ...section("REVENUE BY DELIVERY COMPANY", ["Delivery company", "Completed revenue"]),
    ...data.deliveryRevenue.map((row): Row => [row.name, sar(row.sales)]),
    [],
    ...section("CASH VS WASFATY", [
      "Type",
      "Completed orders",
      "Share of orders",
      "Completed revenue",
      "Share of revenue",
    ]),
    ...orderTypes.rows.map(
      (row): Row => [
        row.label,
        int(row.orders),
        pct(row.ordersPercent),
        sar(row.sales),
        pct(row.salesPercent),
      ],
    ),
    ["Total", int(orderTypes.totalOrders), pct(100), sar(orderTypes.totalSales), pct(100)],
    [],
    ...section("TREND HIGHLIGHTS", ["Metric", "Value", "Day"]),
    [
      "Best day (completed revenue)",
      sar(trendHighlights.best?.completed ?? 0),
      trendHighlights.best?.date ?? "—",
    ],
    [
      "Weakest trading day",
      sar(trendHighlights.weakest?.completed ?? 0),
      trendHighlights.weakest?.date ?? "—",
    ],
    ["Average trading day", sar(trendHighlights.averageDay)],
    ["Days with no revenue", int(trendHighlights.quietDays)],
  ];

  sheet("Revenue Analysis", revenue, widths(34, 22, 22, 22, 20));

  /* ---------------------------------------------------------------------- */
  /* Sheet 3 — Orders Analysis                                               */
  /* ---------------------------------------------------------------------- */

  const orders: Row[] = [
    [`Orders Analysis — ${ctx.label}`],
    [],
    ...section("ORDER COUNTS", ["Metric", "Orders"]),
    ["Total orders", int(summary.totalOrders)],
    ["Completed orders", int(summary.completedOrders)],
    ["Not completed", int(notCompleted)],
    ["Overall completion rate", pct(summary.completionRate)],
    ["Average order value", sar(summary.averageOrderValue)],
    [],
    // The statuses and their names are the `orders_status` RPC's own, which is
    // what the Dashboard's status chart and the Orders filter both read.
    ...section("STATUS BREAKDOWN", ["Status", "Orders"]),
    ...data.statusData.map((row): Row => [row.name, int(row.value)]),
    [],
    ...section("TEAM BREAKDOWN", [
      "Team",
      "Orders",
      "Completed",
      "Completion rate",
      "Cash revenue",
      "Wasfaty revenue",
      "Average order value",
    ]),
    ...[...teams.rows, teams.total].map(
      (row): Row => [
        row.team,
        int(row.orders),
        int(row.completedOrders),
        pct(row.completionRate),
        sar(row.cashSales),
        sar(row.wasfatySales),
        sar(row.averageOrderValue),
      ],
    ),
    [],
    // `summarizeFulfillment`'s own classification — the one the Dashboard and
    // the Orders fulfillment filter use. Not re-decided here.
    ...section("FULFILLMENT (COMPLETED ORDERS)", [
      "Fulfillment",
      "Orders",
      "Share",
      "Cash orders",
      "Wasfaty orders",
    ]),
    ...[
      fulfillment.delivery,
      fulfillment.pickup,
      ...(fulfillment.unknown.count > 0 ? [fulfillment.unknown] : []),
    ].map(
      (row): Row => [
        row.label,
        int(row.count),
        row.key === "unknown" ? null : pct(row.percent),
        int(row.cash),
        int(row.wasfaty),
      ],
    ),
    [
      "Total",
      int(fulfillment.total.count),
      fulfillment.classified.count > 0 ? pct(100) : null,
      int(fulfillment.total.cash),
      int(fulfillment.total.wasfaty),
    ],
  ];

  sheet("Orders Analysis", orders, widths(34, 14, 14, 18, 20, 20, 22));

  /* ---------------------------------------------------------------------- */
  /* Sheet 4 — Call Center                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Every figure here comes from the Calls module's own analytics — the same
   * extension-to-agent mapping, the same team classification, and
   * `resolveQueueOutcomeSplit` for Missed vs Abandoned. Conversion is Telesales
   * only, which is the brief's asymmetry and the module's: an inbound care queue
   * does not convert, so the cell is blank rather than zero.
   */
  const callCenterRows: Row[] = [
    [`Call Center — ${ctx.label}`],
    [],
    ...section("VOLUME BY TEAM", ["Team", "Total calls", "Conversion rate"]),
    ["Customer Care", int(callCenter.customerCare.totalCalls), null],
    ["Telesales", int(callCenter.telesales.totalCalls), pct(callCenter.telesales.conversionRate)],
    ["Overall (whole network)", int(callCenter.overall.totalCalls), null],
    [],
    ...section("CALL QUALITY", ["Metric", "Value"]),
    ["Answered", int(calls.answered)],
    ["Missed", int(calls.missed)],
    ["Abandoned", int(calls.abandoned)],
    ["Average talk time (seconds)", int(Math.round(calls.avgTalkSec ?? 0))],
    [],
    ...section("RATES", ["Metric", "Rate"]),
    ["Answer rate", pct(calls.answerRate)],
    ["Missed rate (of inbound)", pct(calls.missedRate)],
    ["Abandoned rate (of inbound)", pct(calls.abandonedRate)],
    [],
    ...section("SOURCES", ["Metric", "Value"]),
    [
      "Missed / Abandoned split",
      calls.splitSource === "call_report"
        ? "Yeastar queue report"
        : calls.splitSource === "cdr"
          ? "Derived from call records"
          : "Unavailable",
    ],
  ];

  sheet("Call Center", callCenterRows, widths(34, 18, 18));

  XLSX.writeFile(wb, `milaserv_monthly_report_${ctx.from}_${ctx.to}.xlsx`);
}
