/**
 * Environment resolution for the self-hosted cutover.
 *
 * The `MILAPORTAL_` prefix exists because Lovable's secret store rejects `VITE_*`
 * and reserves `SUPABASE_*`, so the cutover values cannot be supplied under the
 * names the application reads. What matters is the precedence: an override has to
 * beat a platform-managed value that is already sitting in `process.env`, or the
 * server keeps talking to Cloud after the cutover and nothing says so.
 *
 * `hydrateServerEnv` latches after its first call, so every case re-imports the
 * module to get a fresh isolate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MILAPORTAL_SUPABASE_URL",
  "MILAPORTAL_SUPABASE_PUBLISHABLE_KEY",
  "MILAPORTAL_SUPABASE_SERVICE_ROLE_KEY",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function hydrate(workerEnv?: unknown) {
  const { hydrateServerEnv } = await import("../server-env");
  hydrateServerEnv(workerEnv);
}

describe("self-hosted override precedence", () => {
  it("beats an ambient platform-managed value", async () => {
    process.env.SUPABASE_URL = "https://cloud.example.supabase.co";
    process.env.MILAPORTAL_SUPABASE_URL = "https://self.hosted.example";

    await hydrate();

    expect(process.env.SUPABASE_URL).toBe("https://self.hosted.example");
  });

  it("beats a VITE_-prefixed worker binding", async () => {
    await hydrate({
      VITE_SUPABASE_URL: "https://cloud.example.supabase.co",
      MILAPORTAL_SUPABASE_URL: "https://self.hosted.example",
    });

    expect(process.env.SUPABASE_URL).toBe("https://self.hosted.example");
  });

  it("applies to the publishable key as well as the URL", async () => {
    await hydrate({ MILAPORTAL_SUPABASE_PUBLISHABLE_KEY: "self-hosted-anon" });

    expect(process.env.SUPABASE_PUBLISHABLE_KEY).toBe("self-hosted-anon");
  });

  it("is read from a worker binding when process.env has nothing", async () => {
    await hydrate({ MILAPORTAL_SUPABASE_URL: "https://self.hosted.example" });

    expect(process.env.SUPABASE_URL).toBe("https://self.hosted.example");
  });
});

describe("existing Lovable Cloud behaviour, preserved while no override is set", () => {
  it("still bridges a VITE_ binding to the unprefixed name", async () => {
    await hydrate({ VITE_SUPABASE_URL: "https://cloud.example.supabase.co" });

    expect(process.env.SUPABASE_URL).toBe("https://cloud.example.supabase.co");
  });

  it("still lets an ambient value win over a binding", async () => {
    process.env.SUPABASE_URL = "https://ambient.example";

    await hydrate({ VITE_SUPABASE_URL: "https://binding.example" });

    expect(process.env.SUPABASE_URL).toBe("https://ambient.example");
  });

  it("leaves everything unset when nothing is supplied", async () => {
    await hydrate();

    expect(process.env.SUPABASE_URL).toBeUndefined();
    expect(process.env.SUPABASE_PUBLISHABLE_KEY).toBeUndefined();
  });
});

describe("the service-role key stays server-side", () => {
  it("resolves from the MILAPORTAL_ name", async () => {
    await hydrate({ MILAPORTAL_SUPABASE_SERVICE_ROLE_KEY: "self-hosted-service-role" });

    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe("self-hosted-service-role");
  });

  it("is NOT honoured from a VITE_-prefixed binding", async () => {
    await hydrate({
      VITE_SUPABASE_SERVICE_ROLE_KEY: "leaked-through-the-browser-boundary",
      MILAPORTAL_SUPABASE_URL: "https://self.hosted.example",
    });

    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("is NOT honoured from an unprefixed binding, which only BRIDGED_KEYS accept", async () => {
    await hydrate({ SUPABASE_SERVICE_ROLE_KEY: "binding-supplied" });

    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("never writes a VITE_ copy of itself", async () => {
    await hydrate({ MILAPORTAL_SUPABASE_SERVICE_ROLE_KEY: "self-hosted-service-role" });

    expect(process.env.VITE_SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});
