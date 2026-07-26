import { parseCoordinatePair, resolveMapUrl, resolveNavUrl } from "@/lib/geo";

/**
 * Turning the master workbook into data the directory can search.
 *
 * Every function here is written against the real "Shams File master location"
 * sheet rather than an idealized schema, because that sheet is hand-maintained
 * and its columns are prose, not fields. The specific shapes being handled are
 * called out at each function; they are not hypothetical.
 */

/**
 * Values that mean "this cell is empty" in a workbook maintained by hand.
 *
 * A literal "-" is by far the most common — it is what the sheet puts in every
 * column of the four facility rows (المستودع, الادارة العامة) that are not
 * pharmacies. Treating it as text would put a dash on screen where the card
 * expects a phone number.
 */
const BLANK_TOKENS = new Set([
  "",
  "-",
  "--",
  "—",
  "–",
  "n/a",
  "na",
  "n.a.",
  "null",
  "none",
  "#n/a",
]);

/** Trim a cell and collapse the sheet's several spellings of "nothing" to null. */
export function cleanCell(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value)
    // Excel leaks a leading "=" onto text cells that were typed starting with a
    // plus sign: the Area Manager Contact column is stored as "=+966 50 073 3054".
    .replace(/^=\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (BLANK_TOKENS.has(text.toLowerCase())) return null;
  return text.length > 0 ? text : null;
}

/* -------------------------------------------------------------------------- */
/* Arabic-aware text normalization                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fold the orthographic variation that makes Arabic search miss.
 *
 * An agent typing "مكه" must find "مكة", and "الطايف" must find "الطائف" — the
 * hamza and the ta marbuta are routinely dropped when typing quickly, and the
 * sheet itself is inconsistent about them. Both the stored haystack and the
 * query run through this, so the two meet in the middle.
 */
export function foldText(input: string): string {
  return (
    input
      .toLowerCase()
      // Harakat (fatha, damma, kasra, sukun, shadda…) and the dagger alef.
      .replace(/[ً-ٰٟ]/g, "")
      // Tatweel — a purely decorative letter-stretching character.
      .replace(/ـ/g, "")
      .replace(/[آأإٱ]/g, "ا") // آ أ إ ٱ  → ا
      .replace(/ى/g, "ي") // ى → ي
      .replace(/ة/g, "ه") // ة → ه
      .replace(/ؤ/g, "و") // ؤ → و
      .replace(/ئ/g, "ي") // ئ → ي
      // Arabic-Indic digits, so ٠٥٩ and 059 are the same query.
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/\s+/g, " ")
      .trim()
  );
}

/* -------------------------------------------------------------------------- */
/* Cities                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Arabic city name → English name and search aliases.
 *
 * The sheet stores cities in Arabic only, but agents search in whichever script
 * their keyboard is in, and half of them type "riyadh". Each entry lists the
 * spellings worth matching; the first English alias is what the map labels.
 *
 * Keys are stored pre-folded, so lookup is `CITY_ALIASES[foldText(name)]`.
 */
const CITY_ALIAS_SOURCE: Record<string, string[]> = {
  الرياض: ["Riyadh", "riyad", "rhd"],
  جدة: ["Jeddah", "jedda", "jiddah", "jed"],
  الطائف: ["Taif", "al taif", "altaif"],
  القصيم: ["Qassim", "al qassim", "buraidah", "unaizah"],
  المدينة: ["Madinah", "medina", "al madinah", "almadinah"],
  تبوك: ["Tabuk", "tabouk"],
  مكة: ["Makkah", "mecca", "mekka"],
  رفحاء: ["Rafha", "rafhaa"],
  الخرج: ["Kharj", "al kharj", "alkharj"],
  الشرقية: ["Eastern Province", "sharqiyah", "dammam", "khobar", "ahsa", "hofuf", "hasa"],
  // Present in the wider network but not in the current master sheet. Listed so
  // a future import gets English search for free rather than silently losing it.
  الدمام: ["Dammam"],
  الخبر: ["Khobar", "al khobar"],
  أبها: ["Abha"],
  جازان: ["Jazan", "jizan"],
  نجران: ["Najran"],
  حائل: ["Hail", "hayil"],
  ينبع: ["Yanbu"],
  الباحة: ["Baha", "al baha"],
  عرعر: ["Arar"],
  سكاكا: ["Sakaka"],
  "خميس مشيط": ["Khamis Mushait", "khamis"],
  الاحساء: ["Al Ahsa", "hofuf", "hasa"],
  الجبيل: ["Jubail"],
  القطيف: ["Qatif"],
  بيشة: ["Bisha"],
  رابغ: ["Rabigh"],
  "حفر الباطن": ["Hafar Al Batin", "hafar"],
  القريات: ["Qurayyat"],
};

const CITY_ALIASES: Record<string, string[]> = Object.fromEntries(
  Object.entries(CITY_ALIAS_SOURCE).map(([arabic, aliases]) => [foldText(arabic), aliases]),
);

/** English name for an Arabic city, or null when it is not one we know. */
export function cityEnglish(city: string | null | undefined): string | null {
  if (!city) return null;
  return CITY_ALIASES[foldText(city)]?.[0] ?? null;
}

/** Every spelling of a city worth indexing, including the original. */
export function cityAliases(city: string | null | undefined): string[] {
  if (!city) return [];
  return [city, ...(CITY_ALIASES[foldText(city)] ?? [])];
}

/* -------------------------------------------------------------------------- */
/* Phone numbers                                                               */
/* -------------------------------------------------------------------------- */

/** Saudi country code, without the plus. */
const KSA_CC = "966";

export interface PhoneParse {
  /** Digits only, exactly as typed (country code included if it was). */
  digits: string;
  /**
   * National significant number — the 9 digits after the country code or trunk
   * zero, e.g. "599089497". Null when the number is not a valid Saudi one.
   *
   * Exposed because it is the join between the several ways the same number is
   * written: the sheet stores "599089497", an agent reads "0599089497" off a
   * customer's screen, and the stored value is "+966599089497". Indexing this
   * plus its 0-prefixed form is what makes all three find the same branch.
   */
  nsn: string | null;
  /** +966… when the number resolves to a valid Saudi number, else null. */
  e164: string | null;
  /** Human-readable grouping of the E.164 form, else the raw text. */
  display: string | null;
  /** True when digits are present but do not form a valid Saudi number. */
  suspicious: boolean;
}

/**
 * Parse a phone cell into a dialable number.
 *
 * The sheet holds three shapes, all of them valid inputs:
 *
 *   - Branch phones as bare 9-digit national numbers: "599089497".
 *   - Area manager mobiles as "=+966 50 073 3054" (see cleanCell for the "=").
 *   - Two rows with a mistyped country code — "968 50 726 2291" and
 *     "969 50 726 2291", where 966 was meant.
 *
 * The third case is deliberately NOT auto-corrected. Guessing that 968 meant
 * 966 would silently hand an agent a number to dial that nobody verified;
 * `suspicious` is set instead so the import preview can raise it as a warning
 * and a human can fix the source.
 */
export function parsePhone(raw: unknown): PhoneParse {
  const text = cleanCell(raw);
  if (!text) return { digits: "", nsn: null, e164: null, display: null, suspicious: false };

  const folded = foldText(text);
  const digits = folded.replace(/\D/g, "");
  if (digits.length === 0)
    return { digits: "", nsn: null, e164: null, display: null, suspicious: false };

  // National significant number: what follows the country code / trunk zero.
  let nsn: string | null = null;
  if (digits.startsWith(KSA_CC) && digits.length === 12) nsn = digits.slice(3);
  else if (digits.startsWith("00" + KSA_CC) && digits.length === 14) nsn = digits.slice(5);
  else if (digits.startsWith("0") && digits.length === 10) nsn = digits.slice(1);
  else if (digits.length === 9) nsn = digits;

  // Saudi subscriber numbers are 9 digits: mobiles open with 5, landlines with
  // 1 (Riyadh), 2 (Makkah/Jeddah), 3 (Eastern), 4 (Qassim/Madinah), 6, 7.
  const valid = nsn != null && /^[1-9]\d{8}$/.test(nsn);
  if (!valid) {
    return { digits, nsn: null, e164: null, display: text, suspicious: true };
  }

  const e164 = `+${KSA_CC}${nsn}`;
  return { digits, nsn, e164, display: formatE164(e164), suspicious: false };
}

/**
 * Every written form of a number that should find the branch it belongs to.
 *
 * An agent reading a number off a customer's phone types "0599089497"; the sheet
 * stores "599089497"; the database holds "+966599089497". None of those three is
 * a substring of both others, so the search index carries all of them.
 */
export function phoneSearchForms(parsed: PhoneParse): string[] {
  const forms = new Set<string>();
  if (parsed.digits) forms.add(parsed.digits);
  if (parsed.e164) forms.add(parsed.e164);
  if (parsed.nsn) {
    forms.add(parsed.nsn);
    forms.add(`0${parsed.nsn}`);
  }
  return [...forms];
}

/** "+966599089497" → "+966 59 908 9497". */
export function formatE164(e164: string): string {
  const nsn = e164.replace(`+${KSA_CC}`, "");
  if (nsn.length !== 9) return e164;
  return `+${KSA_CC} ${nsn.slice(0, 2)} ${nsn.slice(2, 5)} ${nsn.slice(5)}`;
}

/** `tel:` target — E.164 when we have it, else the digits as typed. */
export function telHref(parsed: Pick<PhoneParse, "e164" | "digits">): string | null {
  if (parsed.e164) return `tel:${parsed.e164}`;
  return parsed.digits ? `tel:${parsed.digits}` : null;
}

/* -------------------------------------------------------------------------- */
/* Scooter availability                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Phrases in the Scooter column that mean delivery IS available. The column is
 * free text in Arabic and reads, across the sheet: "سكوتر" (scooter), "دباب"
 * (motorbike), "توصيل مجاني" (free delivery), "سكوتر العامل" (the worker's own
 * scooter), and "مع فرع 8" (covered by branch 8's rider).
 */
const SCOOTER_POSITIVE = ["سكوتر", "دباب", "توصيل مجاني", "توصيل", "مع فرع", "متاح"];

/**
 * Phrases that mean delivery is NOT available. Checked first: "غير متاح ليه
 * توصيل" contains "توصيل", so a positive-only match would read a plain refusal
 * as a yes.
 */
const SCOOTER_NEGATIVE = ["غير متاح", "لا يوجد", "لايوجد", "بدون", "ليس"];

export interface ScooterParse {
  available: boolean;
  /** The original wording, preserved for the card. */
  note: string | null;
}

/**
 * Read the Scooter column.
 *
 * An empty cell is `false`, not "unknown": the directory answers a yes/no
 * question an agent asks mid-call, and the honest default for a branch nobody
 * recorded a rider for is that they should not promise one.
 */
export function parseScooter(raw: unknown): ScooterParse {
  const note = cleanCell(raw);
  if (!note) return { available: false, note: null };
  const folded = foldText(note);
  if (SCOOTER_NEGATIVE.some((token) => folded.includes(foldText(token)))) {
    return { available: false, note };
  }
  const available = SCOOTER_POSITIVE.some((token) => folded.includes(foldText(token)));
  return { available, note };
}

/* -------------------------------------------------------------------------- */
/* Working hours                                                               */
/* -------------------------------------------------------------------------- */

const MINUTES_PER_DAY = 24 * 60;

/** "07 AM", "10.30 AM", "02:30 PM", "8 AM" → minutes past midnight. */
function parseClock(text: string): number | null {
  const match = text.trim().match(/^(\d{1,2})\s*[.:]?\s*(\d{2})?\s*(AM|PM)$/i);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  if (rawHour < 1 || rawHour > 12 || minutes > 59) return null;
  const isPm = match[3].toUpperCase() === "PM";
  const hour = (rawHour % 12) + (isPm ? 12 : 0);
  return hour * 60 + minutes;
}

/**
 * Daily open duration, in hours, from the sheet's free-text hours column.
 *
 * The column is not a single range. Alongside "07 AM - 03 AM" it carries:
 *
 *   - Overnight ranges that cross midnight ("06 AM - 04 AM" = 22 hours).
 *   - "06 AM - 06 AM", meaning open around the clock.
 *   - Overlapping staff shifts joined by "&", which describe one continuous
 *     opening between them: "06 AM - 02 PM & 10 AM - 06 PM & 06 PM - 04 AM" is
 *     a branch open 06:00 → 04:00, i.e. 22 hours, not three separate 8s.
 *   - A genuine midday closure written with "THEN": "09 AM - 02 PM THEN 04 PM -
 *     12 AM" is open 13 hours, with two hours shut in between.
 *
 * Taking the first segment would call the third case 8 hours; taking earliest
 * start to latest end would call the fourth 15. Both are wrong for one of them,
 * so the segments are projected onto a 24-hour circle and unioned — which gives
 * 22 and 13 respectively, and is the only reading that satisfies both.
 */
export function parseDutyHours(raw: unknown): number | null {
  const text = cleanCell(raw);
  if (!text) return null;

  const segments = text
    .split(/&|\bTHEN\b|\+/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  // Half-open intervals on [0, 1440), wrap-around segments split in two.
  const spans: Array<[number, number]> = [];
  for (const segment of segments) {
    const parts = segment.split(/\s*(?:-|–|—|to)\s*/i).filter(Boolean);
    if (parts.length < 2) continue;
    const start = parseClock(parts[0]);
    const end = parseClock(parts[parts.length - 1]);
    if (start == null || end == null) continue;
    if (start === end) return 24; // "06 AM - 06 AM" — around the clock.
    if (end > start) {
      spans.push([start, end]);
    } else {
      spans.push([start, MINUTES_PER_DAY]);
      spans.push([0, end]);
    }
  }
  if (spans.length === 0) return null;

  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let [cursorStart, cursorEnd] = spans[0];
  for (const [start, end] of spans.slice(1)) {
    if (start <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, end);
    } else {
      covered += cursorEnd - cursorStart;
      [cursorStart, cursorEnd] = [start, end];
    }
  }
  covered += cursorEnd - cursorStart;

  const hours = covered / 60;
  // One decimal: "10.30 AM - 01.30 AM" is a real 15-hour day, but
  // "09 AM - 2.30 PM & 4.30 PM - 01 AM" lands on 14.5.
  return Math.round(Math.min(hours, 24) * 10) / 10;
}

/** Chip label for a duty-hours value. 24 gets the phrasing operators use. */
export function dutyHoursLabel(hours: number): string {
  if (hours >= 24) return "Open 24 Hours";
  const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rendered} Hours`;
}

/* -------------------------------------------------------------------------- */
/* Coordinates and links — delegated to the Geo Service                        */
/* -------------------------------------------------------------------------- */

/**
 * Coordinate parsing and map links are NOT implemented here.
 *
 * They live in `@/lib/geo` because branches are not the only thing in the
 * portal with a location: customer addresses, delivery polygons and route
 * waypoints need the same bounds check and the same URL builders, and a second
 * copy inside this feature would be a second set of bounds to keep correct.
 *
 * What remains below is the spreadsheet-shaped adapter: it applies `cleanCell`
 * first, so the sheet's "-" and "N/A" placeholders become nulls before the geo
 * layer — which knows nothing about spreadsheets — ever sees them.
 */
export function parseCoordinate(
  latRaw: unknown,
  lngRaw: unknown,
): { latitude: number | null; longitude: number | null; outOfRange: boolean } {
  const latText = cleanCell(latRaw);
  const lngText = cleanCell(lngRaw);
  if (!latText || !lngText) return { latitude: null, longitude: null, outOfRange: false };

  const { point, outOfRange } = parseCoordinatePair(foldText(latText), foldText(lngText));
  return {
    latitude: point?.lat ?? null,
    longitude: point?.lng ?? null,
    outOfRange,
  };
}

/** @see resolveMapUrl — kept as a named export for the many existing callers. */
export const mapsLink = resolveMapUrl;

/** @see resolveNavUrl */
export const navLink = resolveNavUrl;

/**
 * Is this branch code one of the numbered pharmacies?
 *
 * The master sheet also carries four facility rows — "الادارة العامة" (head
 * office), "الادارة الفرعية" (regional office) and two warehouses both coded
 * "المستودع". They are real locations worth having on the map, but they are not
 * branches an agent sends a customer to, and the duplicate warehouse code is
 * why the importer has to disambiguate rather than assume codes are unique.
 */
export function isNumberedBranch(branchNo: string): boolean {
  return /^P\d{3,5}$/i.test(branchNo.trim());
}
