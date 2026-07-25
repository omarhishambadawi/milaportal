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
