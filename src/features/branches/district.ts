import { cityAliases, foldText } from "./normalize";

/**
 * The district (حي) a branch sits in, read out of its written address.
 *
 * There is no district column. The master sheet writes one address string, and
 * the field agents most often read to a customer — "which حي is it in" — is
 * buried in the middle of it. Rather than add a column (which means an import
 * contract change, a migration, and someone re-typing 144 rows), this pulls the
 * district out of the address the sheet already carries.
 *
 * Derived, therefore conservative: it returns null rather than guess. The
 * address convention in the sheet is `city / area / street` —
 *
 *   الرياض/ حي الحزم /ش علي النقيب
 *   جدة/حي اليرموك
 *   جدة/حراج الصواريخ
 *   الرياض/السلي
 *
 * — so there are exactly two things worth trusting: a segment that names itself
 * a حي, and the segment straight after the city in an address that begins with
 * the city. Anything else (a lone street, a Latin address, a sentence) yields
 * null and the card shows an em dash, which is honest. A district field that is
 * confidently wrong is worse than one that is blank: this is a value agents read
 * aloud to customers who are trying to find the place.
 */

/** Splits the sheet uses between address parts. */
const SEGMENT = /[/\\|،,]+/;

/**
 * A segment that names itself a district: "حي الحزم", "حي رقم 4".
 *
 * Anchored on a word boundary so "حراج" (a market, and a real second segment in
 * this sheet) does not match on its first two letters.
 */
const NAMES_ITSELF = /(^|\s)ح[يى](\s|$)/;

/**
 * Longest positional candidate worth trusting.
 *
 * The `city / area` rule is only as good as the assumption that the second
 * segment is a place name. A 60-character second segment is a sentence with
 * directions in it, not a district.
 */
const MAX_LENGTH = 40;

export function extractDistrict(
  address: string | null | undefined,
  city: string | null | undefined,
): string | null {
  if (!address) return null;

  const segments = address
    .split(SEGMENT)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  const named = segments.find((segment) => NAMES_ITSELF.test(segment));
  if (named) return named.length <= MAX_LENGTH ? named : null;

  // No self-naming segment, so fall back to position — but only for an address
  // that actually follows the convention by leading with the city. "King Fahd
  // Road, Riyadh" must not report a street as a district.
  if (segments.length < 2 || !isCity(segments[0], city)) return null;

  const candidate = segments[1];
  return candidate.length <= MAX_LENGTH ? candidate : null;
}

/**
 * The address minus its leading city segment.
 *
 * The card header already names the city, in Arabic and in English. Repeating
 * it as the first thing in the address below costs a line on every card in the
 * directory to say something the eye read two rows ago — and on a page built to
 * show as many branches at once as possible, that line is the expensive kind.
 *
 * What is left is the district and the street, joined by a middle dot rather
 * than the sheet's slashes: the slashes are a spreadsheet convention, and
 * "حي الحزم · ش علي النقيب" reads as two facts where "حي الحزم/ش علي النقيب"
 * reads as a path.
 *
 * Conservative in the same way `extractDistrict` is. Only the *first* segment is
 * ever dropped, and only when it is recognizably the branch's own city, so an
 * address that does not follow the sheet's convention is returned untouched
 * rather than silently losing its first line.
 */
export function addressWithoutCity(
  address: string | null | undefined,
  city: string | null | undefined,
): string | null {
  if (!address) return null;
  const segments = address
    .split(SEGMENT)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;
  // A one-segment address that *is* the city carries nothing else; anything
  // else is the whole address and is kept as-is.
  const rest = segments.length > 1 && isCity(segments[0], city) ? segments.slice(1) : segments;
  const joined = rest.join(" · ");
  return joined.length > 0 ? joined : null;
}

/** Is this segment the branch's own city, in any spelling we know? */
function isCity(segment: string, city: string | null | undefined): boolean {
  const folded = foldText(segment);
  if (!folded) return false;
  for (const alias of cityAliases(city)) {
    const form = foldText(alias);
    if (!form) continue;
    // `startsWith` in both directions catches "مكة" against "مكة المكرمة", which
    // the sheet writes both ways.
    if (folded === form || folded.startsWith(form) || form.startsWith(folded)) return true;
  }
  return false;
}
