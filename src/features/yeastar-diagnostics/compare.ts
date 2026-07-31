/**
 * KPI comparison between our dashboard and the official Yeastar report.
 *
 * The official figures are ENTERED BY AN ADMINISTRATOR, not fetched. This
 * firmware answers `10001 INTERFACE NOT EXISTED` for
 * `call_report/extension_call_statistics` (and every other call_report route —
 * see `docs/yeastar/live-audit-2026-07-30.md` §1), so there is no API to read
 * the report from. Typing the numbers in from the PBX web UI is the only honest
 * option; inventing a "fetched" official value would be worse than asking.
 *
 * Everything here is pure so it can be tested without a PBX.
 */

/** A KPI we compare. `null` official means "not entered yet". */
export interface KpiComparisonRow {
  key: string;
  label: string;
  dashboard: number;
  official: number | null;
  difference: number | null;
  status: "match" | "mismatch" | "not-entered";
  /** Seconds-valued KPIs render as hh:mm:ss rather than a bare number. */
  format: "count" | "duration" | "percent";
}

/** The official figures an administrator transcribes from the Yeastar report. */
export interface OfficialFigures {
  total: string;
  answered: string;
  noAnswer: string;
  busy: string;
  failed: string;
  inbound: string;
  outbound: string;
  /** "hh:mm:ss" as the Yeastar report prints it. */
  talkTime: string;
}

export const EMPTY_OFFICIAL: OfficialFigures = {
  total: "",
  answered: "",
  noAnswer: "",
  busy: "",
  failed: "",
  inbound: "",
  outbound: "",
  talkTime: "",
};

/** Parse "02:40:31" (or "160:31", or plain seconds) into seconds. */
export function parseDuration(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p.trim()))) return null;
  const n = parts.map((p) => Number(p.trim()));
  return parts.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1];
}

function parseCount(v: string): number | null {
  const s = v.trim().replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface DashboardTotals {
  total: number;
  answered: number;
  noAnswerOutbound: number;
  busy: number;
  failed: number;
  inbound: number;
  outbound: number;
  talkSeconds: number;
  avgTalkSec: number;
  answerRate: number;
}

/**
 * Build the comparison table.
 *
 * Average talk time and answer rate are DERIVED from the official counts rather
 * than transcribed, because the Yeastar report states them to fewer decimal
 * places than we compute — comparing our exact figure against a rounded one
 * would report a mismatch that is only a rounding artefact.
 */
export function buildComparison(
  totals: DashboardTotals,
  official: OfficialFigures,
): KpiComparisonRow[] {
  const oTotal = parseCount(official.total);
  const oAnswered = parseCount(official.answered);
  const oTalk = parseDuration(official.talkTime);

  const row = (
    key: string,
    label: string,
    dashboard: number,
    officialValue: number | null,
    format: KpiComparisonRow["format"] = "count",
    tolerance = 0,
  ): KpiComparisonRow => {
    const difference = officialValue == null ? null : round(dashboard - officialValue);
    return {
      key,
      label,
      dashboard,
      official: officialValue,
      difference,
      status:
        officialValue == null
          ? "not-entered"
          : Math.abs(dashboard - officialValue) <= tolerance
            ? "match"
            : "mismatch",
      format,
    };
  };

  return [
    row("total", "Total Calls", totals.total, oTotal),
    row("answered", "Answered Calls", totals.answered, oAnswered),
    row("noAnswer", "No Answer", totals.noAnswerOutbound, parseCount(official.noAnswer)),
    row("busy", "Busy", totals.busy, parseCount(official.busy)),
    row("failed", "Failed", totals.failed, parseCount(official.failed)),
    row("inbound", "Inbound Calls", totals.inbound, parseCount(official.inbound)),
    row("outbound", "Outbound Calls", totals.outbound, parseCount(official.outbound)),
    row("talkSeconds", "Total Talk Time", totals.talkSeconds, oTalk, "duration"),
    row(
      "avgTalkSec",
      "Average Talk Time",
      round(totals.avgTalkSec),
      oTalk != null && oAnswered ? round(oTalk / oAnswered) : null,
      "duration",
      // The report rounds to whole seconds; anything inside a second agrees.
      1,
    ),
    row(
      "answerRate",
      "Answer Rate",
      round(totals.answerRate),
      oTotal && oAnswered != null ? round((oAnswered / oTotal) * 100) : null,
      "percent",
      0.1,
    ),
  ];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Call comparison table
// ---------------------------------------------------------------------------

export interface CallRow {
  callId: string;
  startedAt: number | null;
  direction: string;
  declaredDirection: string;
  directionCorrected: boolean;
  extension: string;
  agentName: string;
  classification: string;
  included: boolean;
  exclusionReason: string | null;
  talkSeconds: number;
  ringSeconds: number | null;
  queueWaitSeconds: number | null;
  queueNumber: string | null;
  legs: number;
  rootCause: string;
}

export interface CallFilters {
  agentId: string;
  extension: string;
  direction: string;
  callId: string;
  classification: string;
  rootCause: string;
  includedOnly: "all" | "included" | "excluded";
}

export const EMPTY_CALL_FILTERS: CallFilters = {
  agentId: "all",
  extension: "",
  direction: "all",
  callId: "",
  classification: "all",
  rootCause: "all",
  includedOnly: "all",
};

/**
 * Apply the table filters.
 *
 * `extension` and `callId` are substring matches so a partial id pasted from
 * the Yeastar report still finds its row.
 */
export function filterCallRows(
  rows: readonly CallRow[],
  f: CallFilters,
  extensionsForAgent?: ReadonlySet<string> | null,
): CallRow[] {
  const ext = f.extension.trim().toLowerCase();
  const id = f.callId.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.direction !== "all" && r.direction !== f.direction) return false;
    if (f.classification !== "all" && r.classification !== f.classification) return false;
    if (f.rootCause !== "all" && r.rootCause !== f.rootCause) return false;
    if (f.includedOnly === "included" && !r.included) return false;
    if (f.includedOnly === "excluded" && r.included) return false;
    if (ext && !r.extension.toLowerCase().includes(ext)) return false;
    if (id && !r.callId.toLowerCase().includes(id)) return false;
    if (f.agentId !== "all" && r.extension !== f.agentId) return false;
    if (extensionsForAgent && !extensionsForAgent.has(r.extension)) return false;
    return true;
  });
}

/**
 * The calls that plausibly explain one KPI's difference.
 *
 * When the dashboard reports FEWER than the official figure, no row can explain
 * it — the calls are simply not in our dataset — so the inspector returns the
 * shortfall and an empty list, which is itself the finding: the root cause is a
 * missing CDR row, not a misclassified one.
 */
export function inspectMismatch(
  kpi: string,
  rows: readonly CallRow[],
): { candidates: CallRow[]; note: string } {
  switch (kpi) {
    case "noAnswer":
      return {
        candidates: rows.filter((r) => r.classification === "cancelled_by_agent"),
        note: "Calls the agent hung up before the ring timeout. Yeastar counts these outside No Answer.",
      };
    case "total":
    case "answered":
    case "outbound":
    case "talkSeconds":
      return {
        candidates: rows.filter((r) => !r.included),
        note: "Excluded calls are the only rows that can lower these totals. If none of them explains the gap, the calls are absent from the CDR we received — check the Window boundary panel next: a call that started before the window and was still connected when it opened is counted by a report that buckets on end time, and dropped by our start-time filter.",
      };
    case "inbound":
      return {
        candidates: rows.filter((r) => r.directionCorrected || r.direction === "Inbound"),
        note: "Direction corrections move calls out of Inbound; each is listed with the label the PBX originally gave it.",
      };
    default:
      return { candidates: rows.filter((r) => !r.included), note: "" };
  }
}

/**
 * What the Yeastar report is EXPECTED to call this row.
 *
 * Inferred from the known semantics of Reports › Extension Call Statistics, not
 * read from the PBX — there is no API for that report, so nothing here is an
 * observed value. The column exists to make the disagreement legible: when our
 * classification and this expectation differ, the row is worth opening.
 *
 * "not in report" means the call never reached an extension, so Extension Call
 * Statistics does not count it at all.
 */
export function expectedOfficialClassification(r: CallRow): string {
  if (!r.included) {
    switch (r.exclusionReason) {
      case "ivr_only":
        return "not in report";
      case "internal":
        return "not in report";
      case "system_event":
        return "not in report";
      case "after_hours":
      case "queue_closed":
        // The PBX report has no business-hours concept — it still counts these.
        return "counted";
      default:
        return "unknown";
    }
  }
  switch (r.classification) {
    case "answered":
      return "Answered";
    case "no_answer_outbound":
      return "No Answer";
    case "cancelled_by_agent":
      return "counted, not No Answer";
    case "busy":
      return "Busy";
    case "failed":
      return "Failed";
    case "voicemail":
      return "Voicemail";
    case "missed":
    case "abandoned":
      return "queue metric";
    default:
      return "unknown";
  }
}
