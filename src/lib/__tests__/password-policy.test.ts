import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMP_PASSWORD_TTL_HOURS,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  TEMP_PASSWORD_LENGTH,
  TEMP_PASSWORD_TTL_OPTIONS,
  evaluatePassword,
  generateTemporaryPassword,
  isTempPasswordTtl,
  passwordByteLength,
  passwordSchema,
  temporaryPasswordDeadline,
  temporaryPasswordState,
  type TempPasswordFields,
} from "@/lib/password-policy";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("temporaryPasswordState — the three-state encoding", () => {
  /**
   * The encoding is documented once, in migration 20260725003000, and
   * implemented once, here. It is subtle enough that reading the two columns by
   * hand gets it wrong — specifically the last row, where a NULL deadline with
   * the flag still set means "already rotated away", not "no deadline set".
   *
   *   must_change_password = false                     -> none
   *   true,  deadline in the future                    -> active
   *   true,  deadline in the past                      -> expired
   *   true,  deadline IS NULL                          -> expired (rotated away)
   */
  const cases: Array<[string, TempPasswordFields | null | undefined, string]> = [
    ["no profile at all", null, "none"],
    ["undefined profile", undefined, "none"],
    ["flag unset", { must_change_password: false }, "none"],
    ["flag null", { must_change_password: null }, "none"],
    [
      "flag unset but a deadline lingers",
      { must_change_password: false, must_change_password_expires_at: iso(HOUR) },
      "none",
    ],
    [
      "live temporary password",
      { must_change_password: true, must_change_password_expires_at: iso(HOUR) },
      "active",
    ],
    [
      "deadline 48h out",
      { must_change_password: true, must_change_password_expires_at: iso(48 * HOUR) },
      "active",
    ],
    [
      "deadline one second away",
      { must_change_password: true, must_change_password_expires_at: iso(1000) },
      "active",
    ],
    [
      "deadline just passed",
      { must_change_password: true, must_change_password_expires_at: iso(-1000) },
      "expired",
    ],
    [
      "deadline long passed",
      { must_change_password: true, must_change_password_expires_at: iso(-48 * HOUR) },
      "expired",
    ],
    [
      "rotated away (null deadline)",
      { must_change_password: true, must_change_password_expires_at: null },
      "expired",
    ],
    ["rotated away (absent deadline)", { must_change_password: true }, "expired"],
    [
      "unparseable deadline",
      { must_change_password: true, must_change_password_expires_at: "not-a-date" },
      "expired",
    ],
  ];

  it.each(cases)("%s -> %s", (_label, fields, expected) => {
    expect(temporaryPasswordState(fields, NOW)).toBe(expected);
  });

  it("treats a deadline exactly at `now` as expired", () => {
    // Strictly-greater, so the boundary instant is past the deadline rather
    // than on it. A password is not usable in the millisecond it lapses.
    const fields = { must_change_password: true, must_change_password_expires_at: iso(0) };
    expect(temporaryPasswordState(fields, NOW)).toBe("expired");
    expect(temporaryPasswordState(fields, NOW - 1)).toBe("active");
  });

  it("is idempotent for the rotated-away state", () => {
    // expireTemporaryPassword nulls the deadline while leaving the flag set, so
    // a second call must read the same state and change nothing.
    const rotated = { must_change_password: true, must_change_password_expires_at: null };
    expect(temporaryPasswordState(rotated, NOW)).toBe("expired");
    expect(temporaryPasswordState(rotated, NOW + 10 * HOUR)).toBe("expired");
  });

  it("defaults to the current time when no clock is supplied", () => {
    const future = {
      must_change_password: true,
      must_change_password_expires_at: new Date(Date.now() + HOUR).toISOString(),
    };
    const past = {
      must_change_password: true,
      must_change_password_expires_at: new Date(Date.now() - HOUR).toISOString(),
    };
    expect(temporaryPasswordState(future)).toBe("active");
    expect(temporaryPasswordState(past)).toBe("expired");
  });
});

describe("temporaryPasswordDeadline", () => {
  it.each(TEMP_PASSWORD_TTL_OPTIONS)("computes a deadline %d hours out", (hours) => {
    const from = new Date(NOW);
    expect(Date.parse(temporaryPasswordDeadline(hours, from))).toBe(NOW + hours * HOUR);
  });

  it("produces a deadline that reads as active immediately and expired after the window", () => {
    const from = new Date(NOW);
    for (const hours of TEMP_PASSWORD_TTL_OPTIONS) {
      const fields = {
        must_change_password: true,
        must_change_password_expires_at: temporaryPasswordDeadline(hours, from),
      };
      expect(temporaryPasswordState(fields, NOW)).toBe("active");
      expect(temporaryPasswordState(fields, NOW + hours * HOUR)).toBe("expired");
    }
  });

  it("offers a closed set of TTLs and defaults to one of them", () => {
    // A free-form hours field invites someone to type 8760 and reinvent the
    // permanent shared password the expiry exists to prevent.
    expect([...TEMP_PASSWORD_TTL_OPTIONS]).toEqual([24, 48]);
    expect(TEMP_PASSWORD_TTL_OPTIONS).toContain(DEFAULT_TEMP_PASSWORD_TTL_HOURS);
  });

  it.each([0, 1, 12, 72, 8760, -24, "48", null, undefined, {}])(
    "isTempPasswordTtl rejects %p",
    (value) => {
      expect(isTempPasswordTtl(value)).toBe(false);
    },
  );

  it.each(TEMP_PASSWORD_TTL_OPTIONS)("isTempPasswordTtl accepts %d", (value) => {
    expect(isTempPasswordTtl(value)).toBe(true);
  });
});

describe("password policy", () => {
  const accepted = [
    "passw0rd",
    "Sup3rSecret",
    "aaaaaaa1",
    "١٢٣٤٥٦٧٨abc1",
    "correct horse battery 9",
  ];
  const rejected: Array<[string, string]> = [
    ["", "empty"],
    ["short1", "under the length floor"],
    ["abcdefgh", "no digit"],
    ["12345678", "no letter"],
    ["1234567", "too short and no letter"],
  ];

  it.each(accepted)("accepts %j", (value) => {
    expect(passwordSchema.safeParse(value).success, value).toBe(true);
    expect(evaluatePassword(value).valid, value).toBe(true);
  });

  it.each(rejected)("rejects %j (%s)", (value) => {
    expect(passwordSchema.safeParse(value).success, value).toBe(false);
    expect(evaluatePassword(value).valid, value).toBe(false);
  });

  it("rejects anything past the bcrypt truncation point", () => {
    // bcrypt silently truncates beyond 72 BYTES. Accepting longer input makes
    // "the password I typed" and "the password that was stored" differ.
    const atLimit = "a1" + "x".repeat(PASSWORD_MAX_BYTES - 2);
    const overLimit = atLimit + "x";
    expect(passwordByteLength(atLimit)).toBe(PASSWORD_MAX_BYTES);
    expect(passwordSchema.safeParse(atLimit).success).toBe(true);
    expect(passwordSchema.safeParse(overLimit).success).toBe(false);
  });

  it("counts bytes rather than characters for multi-byte input", () => {
    // 24 four-byte characters = 96 bytes but only 24 code points, so a
    // character-length check would wave this through.
    const emoji = "a1" + "😀".repeat(24);
    expect(emoji.length).toBeLessThan(PASSWORD_MAX_BYTES);
    expect(passwordByteLength(emoji)).toBeGreaterThan(PASSWORD_MAX_BYTES);
    expect(passwordSchema.safeParse(emoji).success).toBe(false);
  });

  it("keeps the form checklist and the server schema in agreement", () => {
    // The live checklist and the Zod schema are both built from PASSWORD_RULES,
    // so the UI can never accept something the server will reject.
    const samples = [...accepted, ...rejected.map(([value]) => value), "x".repeat(200), "Aa1"];
    for (const value of samples) {
      expect(evaluatePassword(value).valid, value).toBe(passwordSchema.safeParse(value).success);
    }
  });

  it("reports one checklist result per rule", () => {
    const { results } = evaluatePassword("passw0rd");
    expect(results).toHaveLength(PASSWORD_RULES.length);
    expect(results.map((r) => r.id)).toEqual(PASSWORD_RULES.map((r) => r.id));
  });

  it("enforces the documented eight-character floor", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH - 1) + "1").success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH - 2) + "1").success).toBe(false);
  });
});

describe("generateTemporaryPassword", () => {
  // A generated password is a live credential, so these properties are checked
  // over many samples rather than one: a generator that satisfies the rules
  // only most of the time locks users out of the account they were just given.
  const SAMPLES = 250;
  const generated = Array.from({ length: SAMPLES }, () => generateTemporaryPassword());

  it("always satisfies the password policy it will be validated against", () => {
    for (const value of generated) {
      expect(passwordSchema.safeParse(value).success, value).toBe(true);
      expect(evaluatePassword(value).valid, value).toBe(true);
    }
  });

  it("is always the declared length", () => {
    for (const value of generated) expect(value, value).toHaveLength(TEMP_PASSWORD_LENGTH);
  });

  it("always contains an upper, a lower and a digit", () => {
    for (const value of generated) {
      expect(/[A-Z]/.test(value), value).toBe(true);
      expect(/[a-z]/.test(value), value).toBe(true);
      expect(/[0-9]/.test(value), value).toBe(true);
    }
  });

  it("never emits a character that is ambiguous when read aloud or copied by hand", () => {
    // O/0 and I/l/1 are excluded because a temporary password is dictated far
    // more often than a chosen one.
    for (const value of generated) {
      expect(value, `${value} contains a confusable character`).not.toMatch(/[O0Il1]/);
    }
  });

  it("does not park the guaranteed characters in fixed positions", () => {
    // The generator shuffles after seeding one character per group. Without the
    // shuffle, position 0 would always be upper and position 2 always a digit.
    const digitAtIndexTwo = generated.filter((v) => /[0-9]/.test(v[2])).length;
    expect(digitAtIndexTwo).toBeLessThan(SAMPLES);
  });

  it("does not repeat itself", () => {
    // 14 characters from a 57-character alphabet; a collision in 250 draws means
    // the CSPRNG path has been replaced with something that is not random.
    expect(new Set(generated).size).toBe(SAMPLES);
  });
});
