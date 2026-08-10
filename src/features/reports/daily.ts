import { format, parseISO } from "date-fns";

/**
 * The daily management report, as a value.
 *
 * This module is pure and knows nothing about React, Supabase or Yeastar. It
 * takes figures the Dashboard's own RPCs and the Call Centre's own analytics
 * already produced, and arranges them into the report that currently gets typed
 * by hand into WhatsApp every evening. Nothing here classifies, filters or
 * re-derives anything — a report that recomputed its own totals would be a
 * second source of truth for numbers management already reads on the dashboard,
 * and the first evening the two disagreed the report would be the one believed.
 *
 * The one arithmetic rule it does own is stated in the brief and enforced here:
 * **Total Sales = Cash + Wasfaty.** Not the `total` bucket's own sum, which can
 * include an order whose type is neither, and which would make the printed lines
 * fail to add up in front of the person reading them.
 */

/** How much of the day's work a figure counts. */
export type ReportBasis = "all" | "completed";

export const BASIS_LABEL: Record<ReportBasis, string> = {
  all: "All orders",
  completed: "Completed orders only",
};

/** One team's orders for the day, straight off the `orders_kpis` buckets. */
export interface TeamOrderTotals {
  orders: number;
  cashSales: number;
  wasfatySales: number;
}

/** One team's calls for the day, straight off the call analytics totals. */
export interface TeamCallTotals {
  /** Inbound + outbound. Internal calls are already excluded upstream. */
  total: number;
  inbound: number;
}

export interface TeamDailyFigures extends TeamOrderTotals, TeamCallTotals {
  /** Cash + Wasfaty, always. See the module note. */
  totalSales: number;
}

export interface DailyReport {
  /** ISO date the report covers. */
  date: string;
  /** "Tuesday, August 4, 2026" — how the report heads itself. */
  dateLabel: string;
  telesales: TeamDailyFigures;
  customerCare: TeamDailyFigures;
  /** Customer Care + Telesales. */
  combinedSales: number;
  basis: ReportBasis;
}

export interface DailyReportInput {
  date: string;
  basis: ReportBasis;
  telesales: { orders: TeamOrderTotals; calls: TeamCallTotals };
  customerCare: { orders: TeamOrderTotals; calls: TeamCallTotals };
}

function figures(orders: TeamOrderTotals, calls: TeamCallTotals): TeamDailyFigures {
  return {
    ...orders,
    ...calls,
    totalSales: orders.cashSales + orders.wasfatySales,
  };
}

/** "Tuesday, August 4, 2026", or the raw string if it will not parse. */
export function formatReportDate(iso: string): string {
  try {
    return format(parseISO(iso), "EEEE, MMMM d, yyyy");
  } catch {
    return iso;
  }
}

export function buildDailyReport(input: DailyReportInput): DailyReport {
  const telesales = figures(input.telesales.orders, input.telesales.calls);
  const customerCare = figures(input.customerCare.orders, input.customerCare.calls);

  return {
    date: input.date,
    dateLabel: formatReportDate(input.date),
    telesales,
    customerCare,
    combinedSales: telesales.totalSales + customerCare.totalSales,
    basis: input.basis,
  };
}

/* -------------------------------------------------------------------------- */
/* The text that gets sent                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Money, always to two decimals.
 *
 * Fixed rather than `maximumFractionDigits`, which is what `fmtSAR` uses and
 * what makes a hand-typed report read "3,103.4 SAR" on one line and
 * "11,119.46 SAR" on the next. In a column of figures somebody is going to add
 * up on a phone screen, a missing decimal reads as a typo.
 */
export function money(value: number): string {
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} SAR`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * The rule between sections.
 *
 * Box-drawing (U+2500) rather than hyphens or asterisks. WhatsApp, Telegram and
 * SMS all render it as a continuous line and none of them treats it as markup —
 * where a row of `---` reads as debris and a row of `***` is markup in one app
 * and debris in the next. Twenty-four characters is the widest run that does not
 * wrap in a phone notification preview.
 */
const RULE = "────────────────────────";

/**
 * The report as plain text, ready to paste into WhatsApp.
 *
 * Deliberately not the rendered card's markup, and deliberately not Markdown:
 * WhatsApp renders `*bold*` and swallows stray asterisks, so anything that
 * looked like formatting here would arrive as either bold text or debris in
 * whichever app it is pasted into. Emphasis is carried by structure instead —
 * an upper-case section heading, a rule between sections, a bullet per figure,
 * and an arrow on the line that matters.
 *
 * Three sections, in the order management reads them: Customer Care, Telesales,
 * then the combined total on its own. The previous version ran the two teams
 * together with one blank line between them and closed with a total that looked
 * like it belonged to Customer Care, which is what made a phone screen show it
 * as one continuous block.
 *
 * Every figure here is the same figure the previous message carried, and there
 * is no new arithmetic: the section headings and the rules are the whole change.
 *
 * The arrow is U+27A1 plus a variation selector, which is the glyph the current
 * reports use; keeping it means the automated message looks like the manual one
 * it replaces rather than like a system notification.
 */
export function formatDailyReportText(report: DailyReport): string {
  const { telesales: ts, customerCare: cc } = report;

  const lines = [
    `DAILY REPORT`,
    report.dateLabel,
    RULE,
    ``,
    `CUSTOMER CARE`,
    ``,
    `• Inbound Calls: ${count(cc.inbound)}`,
    `• Total Calls (Inbound & Outbound): ${count(cc.total)}`,
    `• Total Orders: ${count(cc.orders)}`,
    `• Cash Sales: ${money(cc.cashSales)}`,
    `• Wasfaty Sales: ${money(cc.wasfatySales)}`,
    ``,
    `➡️ Total Sales: ${money(cc.totalSales)}`,
    ``,
    RULE,
    ``,
    `TELESALES`,
    ``,
    `• Total Calls: ${count(ts.total)}`,
    `• Total Orders: ${count(ts.orders)}`,
    `• Total Cash: ${money(ts.cashSales)}`,
    `• Total Wasfaty: ${money(ts.wasfatySales)}`,
    ``,
    `➡️ Total Sales: ${money(ts.totalSales)}`,
    ``,
    RULE,
    ``,
    `TOTAL`,
    ``,
    `➡️ Total Daily Sales (Customer Care + Telesales): ${money(report.combinedSales)}`,
  ];

  // Stated only when it is not the default, so the everyday message reads
  // exactly as the one being replaced — but a report deliberately run over
  // completed orders never goes out looking like the usual one.
  if (report.basis === "completed") {
    lines.push(``, `(Completed orders only)`);
  }

  return lines.join("\n");
}
