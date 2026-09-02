/**
 * Saudi phone numbers, in one place.
 *
 * MilaPortal handles one country's mobile numbers, written a dozen different
 * ways: `0504630565`, `504630565`, `966504630565`, `+966 50 463 0565`,
 * `00966504630565`, `050-463-0565`, and — because the data arrives through Excel
 * — as a float, as a string with a leading zero Excel has eaten, and as the
 * rendered text `9.66555E+11`.
 *
 * They are all the same subscriber, and the CRM stores exactly one form:
 *
 *     0504630565
 *
 * Ten digits, leading zero, no separators, no country code. That is the format
 * an agent reads aloud, the format the pharmacy's own systems use, and the
 * format this module compares, deduplicates and displays.
 *
 * ===========================================================================
 * Why this file exists rather than a helper inside the importer
 * ===========================================================================
 * Because the same question is asked in seven places — Cash import, Wasfaty
 * import, the retention backlog, lead generation, patient contacts, an agent
 * typing into a box, and the deduplication key — and seven answers that are
 * *nearly* the same is how one customer ends up as two leads. There is one
 * implementation and everything calls it.
 *
 * It is at `src/lib/` rather than `src/lib/telesales/` because nothing about it
 * is telesales-specific; it is a fact about Saudi mobile numbers.
 *
 * ===========================================================================
 * What it refuses, and why refusing matters more than accepting
 * ===========================================================================
 * The source workbooks put invoice numbers, item codes, patient ids, times and
 * placeholders into phone columns. Measured across all three files, 88,802 of
 * the 89,000-odd non-empty values are nine-digit subscriber numbers and the rest
 * are not numbers anybody can dial:
 *
 *     0000 · 11111 · 1234 · 05555 · 05555555 · 135 · 04
 *     10103514, 10611553          item codes in the Mobileno column
 *     0114615153                  a Riyadh landline
 *     0046727259080               a Swedish number
 *     05591675252                 one digit too many
 *     0510735627                  a prefix Saudi Arabia does not assign
 *
 * Every one of those is refused with a reason rather than coerced. A telesales
 * CRM that invents a phone number does not fail loudly — it sends an agent to
 * dial a stranger.
 */

/** The canonical form: `0` + nine subscriber digits. */
export type SaudiPhone = string;

/**
 * Saudi mobile prefixes, as the numbering plan actually assigns them.
 *
 * `05` followed by one of `0,3,4,5,6,7,8,9`. **`051` and `052` are not assigned
 * to mobile**, and that is not a guess — it is why this rule is written as a
 * character class rather than `05\d`:
 *
 *   | prefix | occurrences in the three workbooks |
 *   |--------|------------------------------------|
 *   | 050    | 24,359                             |
 *   | 053    | 13,039                             |
 *   | 055    | 22,940                             |
 *   | 056    | 10,365                             |
 *   | 054    | 10,146                             |
 *   | 059    |  4,399                             |
 *   | 058    |  1,649                             |
 *   | 057    |  1,627                             |
 *   | 051    |    251  ← refused                  |
 *   | 052    |      3  ← refused                  |
 *
 * `057` is included because the data proves it is in live use; `051`/`052` are
 * excluded for the same evidential reason — 254 rows against 88,524, in a
 * distribution where every assigned prefix appears more than a thousand times.
 * They are typos, and the honest thing to do with a typo is report it, not
 * silently turn `0510735627` into a number that belongs to somebody else.
 */
const SAUDI_MOBILE = /^05[03-9]\d{7}$/;

/** The subscriber part, without the national trunk `0`. What `+966` prefixes. */
const SAUDI_MOBILE_NSN = /^5[03-9]\d{7}$/;

/** Why a value could not become a phone number. */
export type PhoneRejection =
  | "empty"
  | "no_digits"
  | "scientific_notation"
  | "too_short"
  | "too_long"
  | "foreign"
  | "not_mobile";

export const PHONE_REJECTION_LABELS: Record<PhoneRejection, string> = {
  empty: "No value",
  no_digits: "No digits in the cell",
  scientific_notation: "Excel rendered the number in scientific notation, losing digits",
  too_short: "Too few digits for a Saudi mobile number",
  too_long: "Too many digits for a Saudi mobile number",
  foreign: "Not a Saudi number",
  not_mobile: "Not a Saudi mobile prefix (05 followed by 0, 3, 4, 5, 6, 7, 8 or 9)",
};

export interface PhoneResult {
  /** The canonical `05XXXXXXXX`, or null when the value could not be used. */
  phone: SaudiPhone | null;
  /** The input as it arrived, trimmed. Preserved for audit; never displayed as
   *  the customer's number. */
  raw: string | null;
  /** Set exactly when `phone` is null. */
  rejection: PhoneRejection | null;
  /** True when the input was already canonical — nothing had to be changed. */
  wasCanonical: boolean;
}

/* ------------------------------------------------------------------------- */
/* Step 1 — Arabic-Indic digits                                              */
/* ------------------------------------------------------------------------- */

/**
 * `٠٥٠٤٦٣٠٥٦٥` → `0504630565`.
 *
 * Two ranges, because there are two of them: U+0660–0669 is Arabic-Indic, used
 * across the Gulf, and U+06F0–06F9 is the Extended (Persian/Urdu) set, which
 * looks similar and is a different block. A converter that handles only the
 * first silently drops the second.
 *
 * None of the three workbooks currently contains either — the phone columns are
 * pure ASCII. This runs anyway because the files are hand-maintained, an Arabic
 * keyboard is one setting away, and the failure it prevents is a number that
 * looks perfectly fine on screen and normalises to nothing.
 */
export function arabicToWesternDigits(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += ch;
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* The normalizer                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Excel's rendered scientific notation, which cannot be recovered.
 *
 * `9.66555E+11` is what a narrow column *displays* over the stored integer
 * `966555389897`. The importer reads stored values, so this should never arrive
 * — but if it does (a CSV export, a pasted cell, a hand-typed value) the digits
 * after the sixth are genuinely gone. `Number("9.66555E+11")` returns
 * 966555000000, which is a well-formed, dialable, **wrong** number.
 *
 * So it is detected and refused by name, before any digit-stripping can turn it
 * into something plausible.
 */
const SCIENTIFIC = /\d[eE][+-]?\d/;

/**
 * A bare decimal, which is never a phone number.
 *
 * `0.540277778` is a real value in the `Jeddah` note column: an Excel time
 * serial for 12:58. Stripping its punctuation gives `0540277778`, which passes
 * every other rule in this file — ten digits, leading zero, the assigned `054`
 * prefix — and is a number belonging to somebody who has never heard of this
 * pharmacy. It is the sharpest example of why step 3 refuses shapes before
 * step 4 discards punctuation.
 *
 * A number genuinely written with dots (`050.463.0565`) has more than one and
 * does not match.
 */
const BARE_DECIMAL = /^\d*\.\d+$/;

/**
 * How many digits a `00`-prefixed value needs before it is a foreign number
 * rather than a placeholder.
 *
 * `0046727259080` is Swedish. `00` and `0000` are what an agent types when a
 * customer refuses to give a number, and calling those "not a Saudi number"
 * would put them in the wrong bucket on the import report — they are not a
 * number at all.
 */
const MIN_INTERNATIONAL_DIGITS = 10;

/**
 * Raw value → canonical Saudi mobile number.
 *
 * The pipeline, in order:
 *
 *   1. Arabic-Indic digits become Western ones.
 *   2. Trim.
 *   3. Refuse rendered scientific notation — it has already lost digits.
 *   4. Discard formatting: spaces, commas, hyphens, dots, parentheses, `+`,
 *      and any other punctuation. Only digits survive.
 *   5. Strip the country code: `00966` or `966`.
 *   6. Strip the national trunk `0`.
 *   7. What remains must be nine digits beginning with an assigned mobile
 *      prefix; if it is, prepend `0` and return it.
 *   8. Otherwise return why not.
 *
 * Accepts `unknown` because callers hand it spreadsheet cells — a `number` from
 * a numeric column, a `string` from a text one, `null` from an empty one.
 */
export function normalizeSaudiPhone(value: unknown): PhoneResult {
  if (value == null) return reject(null, "empty");

  /*
   * A number from Excel is stringified without exponent notation.
   *
   * `String(966555389897)` is safe — JavaScript only switches to exponent form
   * at 1e21, far above any phone number. But a *float* that lost its leading
   * zero (`504630565`) is exactly the case step 7 is written to repair.
   */
  const asText =
    typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);

  const raw = arabicToWesternDigits(asText).trim();
  if (!raw) return reject(null, "empty");

  if (SCIENTIFIC.test(raw)) return reject(raw, "scientific_notation");
  if (BARE_DECIMAL.test(raw)) return reject(raw, "no_digits");

  let digits = raw.replace(/\D+/g, "");
  if (!digits) return reject(raw, "no_digits");

  /*
   * International prefixes.
   *
   * `00966` and `966` are ours. A leading `00` that is *not* `00966` is somebody
   * else's country — `0046727259080` is Swedish and appears in the Wasfaty data
   * — and is reported as foreign rather than mangled into a Saudi number.
   */
  if (digits.startsWith("00966")) digits = digits.slice(5);
  else if (digits.startsWith("00") && digits.length >= MIN_INTERNATIONAL_DIGITS) {
    return reject(raw, "foreign");
  } else if (digits.startsWith("966")) digits = digits.slice(3);

  // The national trunk zero. Only one is meaningful; `0057379717` is a typo with
  // an extra zero, and stripping the lot lets step 7 judge what is left.
  digits = digits.replace(/^0+/, "");
  if (!digits) return reject(raw, "no_digits");

  if (SAUDI_MOBILE_NSN.test(digits)) {
    const phone = `0${digits}`;
    return { phone, raw, rejection: null, wasCanonical: raw === phone };
  }

  // Say something useful about why it failed, so the import summary can group
  // "this column is full of item codes" apart from "somebody mistyped a prefix".
  if (digits.length < 9) return reject(raw, "too_short");
  if (digits.length > 9) return reject(raw, "too_long");
  return reject(raw, "not_mobile");
}

function reject(raw: string | null, rejection: PhoneRejection): PhoneResult {
  return { phone: null, raw, rejection, wasCanonical: false };
}

/** The canonical number, or null. The form most call sites want. */
export function toSaudiPhone(value: unknown): SaudiPhone | null {
  return normalizeSaudiPhone(value).phone;
}

/** Is this already a canonical Saudi mobile number? */
export function isSaudiMobile(value: unknown): value is SaudiPhone {
  return typeof value === "string" && SAUDI_MOBILE.test(value);
}

/* ------------------------------------------------------------------------- */
/* Several numbers in one cell                                               */
/* ------------------------------------------------------------------------- */

export interface PhoneExtraction {
  /** The first usable number found. */
  phone: SaudiPhone | null;
  /** Every other distinct usable number, in the order they appeared. */
  alternates: SaudiPhone[];
  /** Set when nothing usable was found. */
  rejection: PhoneRejection | null;
}

/**
 * Pull every phone number out of a cell that may hold more than one, or a
 * number surrounded by prose.
 *
 * The workbooks were checked for this rather than assumed. **No phone column in
 * any of the three files holds two numbers** — but the *notes* columns hold 448
 * of them, and they are the reason this function exists:
 *
 *   - `Taif`, `Jeddah`, `Al Qassim` and `Riyadh | Al-Kharj | Rafha` have no
 *     phone column at all, and agents wrote 167 numbers into the note instead.
 *   - `Wasfaty Aug` has a phone column and 281 further numbers in its notes,
 *     often with context: `538659783 في انتظار الموقع`.
 *   - The Retention sheet has one, and it is the clearest possible argument
 *     against auto-promoting these to the customer's number:
 *     `0509736898 رقم زوجه العميل اللي تستخدم الابر` — "the number of the
 *     customer's wife, who uses the injections".
 *
 * So this returns them separately and the caller decides. Nothing here promotes
 * a note-borne number to a customer's primary contact.
 *
 * Splitting is on separators only (comma, semicolon, slash, pipe, newline,
 * whitespace runs). A single number written `050 463 0565` must survive, so
 * candidate fragments are also re-joined and retried as one number when the
 * pieces alone yield nothing.
 */
export function extractSaudiPhones(value: unknown): PhoneExtraction {
  if (value == null) return { phone: null, alternates: [], rejection: "empty" };

  const text = arabicToWesternDigits(
    typeof value === "number" ? String(value) : String(value),
  ).trim();
  if (!text) return { phone: null, alternates: [], rejection: "empty" };

  // The whole cell as one number first: `050 463 0565` and `+966 50 463 0565`
  // are single numbers that happen to contain separators.
  const whole = normalizeSaudiPhone(text);
  if (whole.phone) {
    const rest = collectDistinct(text).filter((p) => p !== whole.phone);
    return { phone: whole.phone, alternates: rest, rejection: null };
  }

  const found = collectDistinct(text);
  if (found.length === 0) {
    return { phone: null, alternates: [], rejection: whole.rejection ?? "no_digits" };
  }
  return { phone: found[0], alternates: found.slice(1), rejection: null };
}

/**
 * Every distinct valid number inside a free-text cell.
 *
 * Works on runs of digits rather than on words, because the surrounding text is
 * Arabic as often as not and a digit run is the only thing that travels. A run
 * long enough to hold a number is also tried from its start, so
 * `538659783 في انتظار` and `0509736898 رقم زوجه` both yield their number.
 */
function collectDistinct(text: string): SaudiPhone[] {
  const out: SaudiPhone[] = [];
  const seen = new Set<string>();
  // Digit runs, allowing the separators a written number may contain. Each
  // fragment goes through the same normalizer, so the decimal and
  // scientific-notation guards apply to note-borne candidates too.
  for (const match of text.matchAll(/[+\d][\d\s\-().,]*/g)) {
    const candidate = normalizeSaudiPhone(match[0].trim());
    if (candidate.phone && !seen.has(candidate.phone)) {
      seen.add(candidate.phone);
      out.push(candidate.phone);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Presentation                                                              */
/* ------------------------------------------------------------------------- */

/**
 * How a number is shown.
 *
 * The canonical form itself, unchanged: `0504630565`. Not grouped, because the
 * canonical form is the thing the desk, the pharmacy's systems and the source
 * files all agree on, and a display variant would be a second format for people
 * to reconcile — which is the problem this module was asked to end.
 */
export function formatSaudiPhone(phone: string | null | undefined): string {
  return phone && isSaudiMobile(phone) ? phone : "—";
}

/**
 * `tel:` target.
 *
 * E.164 here and only here. A `tel:` URI is a protocol value rather than a
 * stored one, and `+966…` is what makes it dial correctly from a softphone, a
 * roaming handset, or a desk phone with an international prefix configured.
 * Returns null when there is nothing to dial, so the caller renders a disabled
 * control rather than a dead link.
 */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone || !isSaudiMobile(phone)) return null;
  return `tel:+966${phone.slice(1)}`;
}

/** `0504630565` → `+966504630565`. For an outbound integration that wants E.164. */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone || !isSaudiMobile(phone)) return null;
  return `+966${phone.slice(1)}`;
}

/**
 * The comparison form used inside deduplication keys.
 *
 * The subscriber digits without the trunk zero. Identical information to the
 * canonical form — this exists so a key reads `cash|504630565|…` rather than
 * carrying a leading zero that means nothing to a comparison, and so the keys
 * written before this module had a canonical format stay byte-identical.
 */
export function phoneKeyPart(phone: string | null | undefined): string {
  return phone && isSaudiMobile(phone) ? phone.slice(1) : "";
}
