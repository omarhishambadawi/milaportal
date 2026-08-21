/**
 * The AlShrouq configuration probe.
 *
 * `fetch` is stubbed, so no credentials, no network and no CRM. The stub
 * credentials are obvious fakes and exist only to make `readCrmEnv` return a
 * value, matching `client.test.ts`.
 *
 * The fixture is the shape of the response captured in the PharmacyCRM Desktop
 * package on 2026-08-20, reduced to four branches. Reducing it is the point:
 * the probe must report the count the CRM sends rather than a number this
 * repository believes, so nothing here asserts 136.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCrmSession } from "@/lib/shams-crm/client.server";
import { runAlShrouqConfigProbe } from "@/lib/shams-crm/alshrouq-config.server";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const LOGIN_OK = { session_token: "stub-session", id: 1, role: "manager", branch_code: "P0001" };

function branch(code: string, id: string, covered: boolean) {
  return {
    id,
    label: covered ? `${code} | Branch ${code}` : `${code} | Not Covered | Not Covered`,
    internal_code: code,
    branch_name: covered ? `Branch ${code}` : "Not Covered",
    covered,
    note: covered ? null : "Not Covered",
  };
}

const CONFIG_OK = {
  integration_base: "https://alshrouqdelivery.com/api/integration",
  management_base: "https://alshrouqdelivery.com/api/integration",
  webhook_url: "https://shams-crm.cloud/integrations/alshrouq/webhook",
  webhook_auth_header: "Authorization",
  webhook_auth_value: "stub-not-a-real-secret",
  branch_options: [
    branch("P0001", "9999927657121", true),
    branch("P0002", "9999927657122", true),
    branch("P0003", "9999927657123", true),
    branch("P0007", "9999927657127", false),
  ],
  payment_options: [
    { id: 1, label: "COD" },
    { id: 2, label: "SPAN Machine" },
    { id: 3, label: "Paid" },
    { id: 4, label: "AlshrouqPay" },
  ],
  missing_secrets: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

function pathsAsked(): string[] {
  return fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname);
}

beforeEach(() => {
  _resetCrmSession();
  process.env.SHAMS_CRM_USERNAME = "stub-user";
  process.env.SHAMS_CRM_PASSWORD = "stub-pass";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SHAMS_CRM_USERNAME;
  delete process.env.SHAMS_CRM_PASSWORD;
});

describe("runAlShrouqConfigProbe", () => {
  it("reports not configured without credentials, and asks nothing", async () => {
    delete process.env.SHAMS_CRM_USERNAME;
    delete process.env.SHAMS_CRM_PASSWORD;

    const result = await runAlShrouqConfigProbe();

    expect(result.configured).toBe(false);
    expect(result.request).toBeNull();
    expect(result.shapeValid).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the config and describes it", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse(CONFIG_OK));

    const result = await runAlShrouqConfigProbe();

    expect(result).toEqual({
      configured: true,
      request: "success",
      paymentOptionIds: [1, 2, 3, 4],
      paymentOptionsMatchContract: true,
      branchOptionCount: 4,
      coveredBranchCount: 3,
      branchFieldsComplete: true,
      webhookUrlPresent: true,
      webhookAuthHeaderPresent: true,
      missingSecrets: [],
      shapeValid: true,
      errorKind: null,
    });
  });

  /**
   * The guarantee this phase exists to make. An order-creating call would be a
   * second entry here, so the assertion is on the whole list, not on absence of
   * one path.
   */
  it("touches only /login and the config endpoint", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse(CONFIG_OK));

    await runAlShrouqConfigProbe();

    expect(pathsAsked()).toEqual(["/login", "/integrations/alshrouq/config"]);
    expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit)?.method !== "DELETE")).toBe(
      true,
    );
  });

  it("returns no secret from the response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse(CONFIG_OK));

    const result = await runAlShrouqConfigProbe();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CONFIG_OK.webhook_auth_value);
    expect(serialized).not.toContain("stub-session");
    expect(serialized).not.toContain("stub-user");
    expect(serialized).not.toContain("stub-pass");
  });

  it("reports the CRM's payment ids even when they are not the four we know", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_OK)).mockResolvedValueOnce(
      jsonResponse({
        ...CONFIG_OK,
        payment_options: [...CONFIG_OK.payment_options, { id: 5, label: "Something New" }],
      }),
    );

    const result = await runAlShrouqConfigProbe();

    // Surfaced, not dropped: the list belongs to the CRM.
    expect(result.paymentOptionIds).toEqual([1, 2, 3, 4, 5]);
    expect(result.paymentOptionsMatchContract).toBe(false);
    expect(result.shapeValid).toBe(false);
  });

  it("counts a covered branch by the flag, not by its note", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_OK)).mockResolvedValueOnce(
      jsonResponse({
        ...CONFIG_OK,
        branch_options: [branch("P0001", "9999927657121", true)],
      }),
    );

    const result = await runAlShrouqConfigProbe();

    // `note` is null on a covered branch; presence of the key is what counts,
    // or 118 healthy branches would read as incomplete.
    expect(result.branchFieldsComplete).toBe(true);
    expect(result.coveredBranchCount).toBe(1);
  });

  it("flags a branch option missing a contract field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LOGIN_OK)).mockResolvedValueOnce(
      jsonResponse({
        ...CONFIG_OK,
        branch_options: [{ id: "9999927657121", label: "P0001", internal_code: "P0001" }],
      }),
    );

    const result = await runAlShrouqConfigProbe();

    expect(result.branchFieldsComplete).toBe(false);
    expect(result.shapeValid).toBe(false);
  });

  it("reports missing integration secrets by name", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse({ ...CONFIG_OK, missing_secrets: ["alshrouq_token"] }));

    const result = await runAlShrouqConfigProbe();

    expect(result.missingSecrets).toEqual(["alshrouq_token"]);
    expect(result.shapeValid).toBe(false);
  });

  it("reports a rejected session as an error kind rather than throwing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValue(jsonResponse({ detail: "nope" }, 401));

    const result = await runAlShrouqConfigProbe();

    expect(result.configured).toBe(true);
    expect(result.request).toBe("failed");
    expect(result.errorKind).toBe("auth_failed");
    expect(result.shapeValid).toBeNull();
  });
});
