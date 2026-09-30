import { afterEach, describe, expect, it, vi } from "vitest";

const token = vi.hoisted(() => ({ value: "id-token" as string | null }));
vi.mock("./firebase", () => ({
  auth: { get currentUser() { return token.value ? { getIdToken: async () => token.value } : null; } },
}));
import {
  ConnectError,
  decide,
  describeScope,
  grantsSummary,
  listGrants,
  loadRequest,
  requestParam,
  revokeGrant,
} from "./mcpClients";

afterEach(() => {
  vi.unstubAllGlobals();
  token.value = "id-token";
});
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("requestParam", () => {
  it("reads the signed request from the address, and nothing else", () => {
    expect(requestParam("?request=abc.def.ghi")).toBe("abc.def.ghi");
    expect(requestParam("?other=1")).toBe("");
    expect(requestParam("")).toBe("");
    expect(requestParam("?request=" + "x".repeat(9000))).toBe("");
  });
});

describe("loadRequest", () => {
  it("returns what the consent page shows", async () => {
    vi.stubGlobal("fetch", reply(200, { clientName: "Claude", redirectHost: "claude.ai", scopes: ["meetings:read", "meetings:live"] }));
    await expect(loadRequest("signed")).resolves.toEqual({ clientName: "Claude", redirectHost: "claude.ai", scopes: ["meetings:read", "meetings:live"] });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain("request=signed");
  });
  it("says the request is stale instead of showing a broken page", async () => {
    vi.stubGlobal("fetch", reply(400, { error: "invalid_request" }));
    await expect(loadRequest("signed")).rejects.toMatchObject({ reason: "expired" });
  });
});

describe("decide", () => {
  it("sends the user's identity and returns where to go next", async () => {
    vi.stubGlobal("fetch", reply(200, { redirectTo: "https://claude.ai/cb?code=1" }));
    await expect(decide("signed", true, ["meetings:read"])).resolves.toBe("https://claude.ai/cb?code=1");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer id-token");
    expect(JSON.parse(String(init.body))).toEqual({ request: "signed", approve: true, scopes: ["meetings:read"] });
  });
  it("refuses to redirect anywhere but http(s)", async () => {
    vi.stubGlobal("fetch", reply(200, { redirectTo: "javascript:alert(1)" }));
    await expect(decide("signed", true, ["meetings:read"])).rejects.toBeInstanceOf(ConnectError);
  });
  it("explains a missing Drive connection in German and in terms of what to do", async () => {
    vi.stubGlobal("fetch", reply(409, { error: "no_drive_grant" }));
    await expect(decide("signed", true, ["meetings:read"])).rejects.toMatchObject({ reason: "no_drive", message: expect.stringMatching(/Google Drive/) });
  });
  it("needs a signed-in user", async () => {
    token.value = null;
    vi.stubGlobal("fetch", reply(200, {}));
    await expect(decide("signed", true, [])).rejects.toMatchObject({ reason: "signed_out" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("grants", () => {
  it("lists and revokes with the user's identity", async () => {
    vi.stubGlobal("fetch", reply(200, { grants: [{ id: "g1", clientName: "Claude", redirectHost: "claude.ai", scopes: ["meetings:read"], createdAt: 1, lastUsedAt: null }] }));
    expect(await listGrants()).toHaveLength(1);
    vi.stubGlobal("fetch", reply(200, { revoked: true }));
    await revokeGrant("g1");
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/mcp/grants/g1");
    expect(init.method).toBe("DELETE");
  });
  it("encodes the id it puts into the address", async () => {
    vi.stubGlobal("fetch", reply(200, { revoked: true }));
    await revokeGrant("a/b?c");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/mcp/grants/a%2Fb%3Fc");
  });
});

describe("wording", () => {
  it("describes each scope in plain German", () => {
    expect(describeScope("meetings:read")).toMatch(/Zusammenfassungen|Transkripte/);
    expect(describeScope("meetings:live")).toMatch(/laufend|live/i);
  });
  it("summarises what an assistant may do", () => {
    expect(grantsSummary(["meetings:read"])).toBe("Vergangene Meetings lesen");
    expect(grantsSummary(["meetings:read", "meetings:live"])).toBe("Vergangene und laufende Meetings lesen");
    expect(grantsSummary(["meetings:live"])).toBe("Laufende Meetings mitlesen");
  });
});
