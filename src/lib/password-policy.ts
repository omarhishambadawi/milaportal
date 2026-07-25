/**
 * Single source of truth for password strength rules.
 *
 * Shared by the client (live checklist in the change-password form) and the
 * server (Zod validation inside the server functions that actually set a
 * password), so the UI can never accept something the server will reject — or
 * vice versa.
 *
 * The 8-character floor matches the platform's existing baseline (`adminCreateUser`
 * and the reset-password flow both required `min(8)` before this file existed).
 */
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;

/**
 * bcrypt — which is what Supabase Auth hashes with — silently truncates input
 * beyond 72 *bytes*. Anything longer gives users a false sense of strength and
 * makes "the password I typed" and "the password that was stored" differ, so it
 * is rejected outright rather than quietly cut.
 */
export const PASSWORD_MAX_BYTES = 72;

/** Byte length, not character length — multi-byte characters count for more. */
export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export interface PasswordRule {
  id: string;
  label: string;
  test: (value: string) => boolean;
}

/** Ordered for display: the checklist in the UI renders these top to bottom. */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: "length",
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (v) => v.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: "letter",
    label: "Contains a letter",
    test: (v) => /\p{L}/u.test(v),
  },
  {
    id: "number",
    label: "Contains a number",
    test: (v) => /\d/.test(v),
  },
  {
    id: "maxBytes",
    label: `No longer than ${PASSWORD_MAX_BYTES} bytes`,
    test: (v) => passwordByteLength(v) <= PASSWORD_MAX_BYTES,
  },
] as const;

/** Per-rule pass/fail plus an overall verdict — drives the live UI checklist. */
export function evaluatePassword(value: string) {
  const results = PASSWORD_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    passed: rule.test(value),
  }));
  return { results, valid: results.every((r) => r.passed) };
}

/**
 * Alphabet for generated temporary passwords.
 *
 * Deliberately excludes the character pairs that are indistinguishable in most
 * UI fonts — O/0, I/l/1 — because a temporary password is *read aloud or copied
 * by hand* far more often than a chosen one, and a user who mistypes it is
 * locked out of the account they were just given. The three groups are kept
 * separate so the generator can guarantee at least one of each rather than
 * hoping randomness supplies it.
 */
const TEMP_UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const TEMP_LOWER = "abcdefghijkmnpqrstuvwxyz";
const TEMP_DIGIT = "23456789";
const TEMP_ALPHABET = TEMP_UPPER + TEMP_LOWER + TEMP_DIGIT;

/** Length of a generated temporary password — comfortably above the 8 floor. */
export const TEMP_PASSWORD_LENGTH = 14;

/**
 * Uniform random index into `max`, from the platform CSPRNG.
 *
 * `Math.random()` is not a CSPRNG, and a temporary password is a live credential
 * for the account — so this uses `crypto.getRandomValues` and rejects values in
 * the final, incomplete bucket of the byte range, which is what keeps the
 * distribution uniform (a plain `% max` would bias toward the low indices).
 */
function randomIndex(max: number): number {
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

function randomChar(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)];
}

/**
 * A random password that satisfies {@link PASSWORD_RULES} by construction.
 *
 * One guaranteed character from each group, the remainder drawn from the whole
 * alphabet, then shuffled (Fisher–Yates with the same CSPRNG) so the guaranteed
 * characters do not always occupy the first three positions.
 *
 * Generated in the browser rather than on the server on purpose: the value has
 * to be shown to the administrator so they can pass it on, so a server-generated
 * one would travel back over the wire and sit in a response payload for no gain.
 * It reaches the server the same way a typed password does — through
 * `adminSetPassword`, which validates it against the same schema.
 */
export function generateTemporaryPassword(): string {
  const chars = [randomChar(TEMP_UPPER), randomChar(TEMP_LOWER), randomChar(TEMP_DIGIT)];
  while (chars.length < TEMP_PASSWORD_LENGTH) chars.push(randomChar(TEMP_ALPHABET));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * How long an administrator-issued password stays usable.
 *
 * A closed set rather than a free number: the choice is "today or this weekend",
 * and an arbitrary-hours field invites someone to type 8760 and reinvent the
 * permanent shared password this is here to prevent.
 */
export const TEMP_PASSWORD_TTL_OPTIONS = [24, 48] as const;
export type TempPasswordTtlHours = (typeof TEMP_PASSWORD_TTL_OPTIONS)[number];
export const DEFAULT_TEMP_PASSWORD_TTL_HOURS: TempPasswordTtlHours = 48;

export function isTempPasswordTtl(value: unknown): value is TempPasswordTtlHours {
  return (TEMP_PASSWORD_TTL_OPTIONS as readonly unknown[]).includes(value);
}

/** Deadline for a password issued now. Computed server-side — a client-supplied
 *  timestamp would let the caller grant themselves an unlimited window. */
export function temporaryPasswordDeadline(hours: TempPasswordTtlHours, from = new Date()): string {
  return new Date(from.getTime() + hours * 60 * 60 * 1000).toISOString();
}

/** What state an account's credential is in, as far as forced changes go. */
export type TempPasswordState = "none" | "active" | "expired";

/** The two columns that carry it. Shape shared by the profile and the admin row. */
export interface TempPasswordFields {
  must_change_password?: boolean | null;
  must_change_password_expires_at?: string | null;
}

/**
 * Decode {@link TempPasswordFields} into one of three states.
 *
 * The single implementation of the encoding described in migration
 * 20260725003000 — the app layout, the users table and the server functions all
 * ask this rather than comparing the columns themselves, because the subtle case
 * (`must_change_password` true with a NULL deadline meaning "already rotated
 * away, recoverable only by email") is exactly the one that gets misread when
 * the check is written out by hand a fourth time.
 */
export function temporaryPasswordState(
  fields: TempPasswordFields | null | undefined,
  now: number = Date.now(),
): TempPasswordState {
  if (!fields?.must_change_password) return "none";
  const deadline = fields.must_change_password_expires_at;
  if (!deadline) return "expired";
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return "expired";
  return at > now ? "active" : "expired";
}

/**
 * Zod schema for a new password. Used by every server function that sets one, so
 * the policy is enforced at the trust boundary rather than only in the form.
 */
export const passwordSchema = z.string().superRefine((value, ctx) => {
  for (const rule of PASSWORD_RULES) {
    if (!rule.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: rule.label });
    }
  }
});
