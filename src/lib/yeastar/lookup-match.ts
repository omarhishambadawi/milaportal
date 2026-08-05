/**
 * Phone-number matching for Call Lookup.
 *
 * Pure and dependency-free on purpose: this is the logic that decides whether
 * two recordings of a phone number are the same person, and it needs to be
 * testable without dragging in the server-function bundle it is used from.
 *
 * The problem it solves: the PBX files one subscriber under several spellings
 * depending on which trunk the call arrived on — `0501234567`, `501234567`,
 * `966501234567` and `+966501234567` are all the same customer. Nothing
 * normalizes them at the source, so both ends of the lookup have to cope:
 *
 *   - `matchKey` is the LOCAL comparison — trailing digits, applied to rows we
 *     already hold. It is authoritative.
 *   - `numberVariants` is the REMOTE pre-filter — the spellings to ask the PBX
 *     for, because `/cdr/search` matches `call_from` / `call_to` exactly.
 */

/**
 * How many trailing digits must match.
 *
 * The PBX records the same subscriber inconsistently — `0501234567`,
 * `+966501234567` and `966501234567` are one person — so comparison is on the
 * trailing digits rather than the whole string. Nine is the KSA subscriber
 * number without its country code or trunk zero, which is the longest suffix
 * every recorded form still shares.
 */
export const LOOKUP_SUFFIX_DIGITS = 9;

/** A shorter query than this matches half the country; refuse rather than sweep. */
export const LOOKUP_MIN_DIGITS = 4;

/** Saudi Arabia. The only country code this PBX's trunks present. */
const KSA_COUNTRY_CODE = "966";

/** Digits only. `+966 50 123 4567` → `966501234567`. */
export function digitsOf(value: string): string {
  return value.replace(/\D+/g, "");
}

/**
 * The trailing slice two recordings of the same subscriber always share.
 *
 * Numbers at or below the suffix length pass through verbatim, which is what
 * lets a search for an internal extension (`4005`) work: it is compared whole,
 * not padded or prefixed.
 */
export function matchKey(value: string | null | undefined): string {
  const d = digitsOf(String(value ?? ""));
  return d.length > LOOKUP_SUFFIX_DIGITS ? d.slice(-LOOKUP_SUFFIX_DIGITS) : d;
}

/**
 * Every spelling the PBX might have filed this subscriber under.
 *
 * `/cdr/search` matches `call_from` / `call_to` EXACTLY unless fuzzy search is
 * switched on PBX-side, so asking for `0501234567` would not find the same
 * person recorded as `+966501234567`. Rather than depend on a PBX setting this
 * code cannot see, every form is asked for and the results unioned — which is
 * what "optimize all lookup paths" means when the store keeps several formats.
 *
 * Ordered most-likely-first: the live samples record callers in the local
 * trunk-zero form, and the first variant is the one that probes whether the
 * firmware honours the filter at all.
 *
 * A query shorter than the suffix length is passed through as typed. Those only
 * ever match short internal numbers, and `matchKey` compares those verbatim, so
 * no prefixing applies.
 */
export function numberVariants(input: string): string[] {
  const digits = digitsOf(input);
  const raw = input.trim();
  const ordered: string[] = [];
  const add = (v: string) => {
    if (v && !ordered.includes(v)) ordered.push(v);
  };

  if (digits.length >= LOOKUP_SUFFIX_DIGITS) {
    const s = digits.slice(-LOOKUP_SUFFIX_DIGITS);
    add(`0${s}`);
    add(s);
    add(`${KSA_COUNTRY_CODE}${s}`);
    add(`+${KSA_COUNTRY_CODE}${s}`);
    add(`00${KSA_COUNTRY_CODE}${s}`);
  }
  add(digits);
  add(raw);
  return ordered;
}
