/**
 * Tests for proxy assignments import/export/apply/bulk endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-proxy-assignments-data"),
  getConfigDir: vi.fn(() => "/tmp/test-proxy-assignments-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null },
  })),
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token}@test.com`,
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
}));

vi.mock("../../tls/transport.js", () => ({
  getTransport: vi.fn(),
  getTransportInfo: vi.fn(() => ({})),
}));

import { Hono } from "hono";
import { AccountPool } from "../../auth/account-pool.js";
import { ProxyPool } from "../../proxy/proxy-pool.js";
import { createProxyRoutes } from "../proxies.js";

describe("proxy assignments import/export/apply/bulk", () => {
  let accountPool: AccountPool;
  let proxyPool: ProxyPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    accountPool = new AccountPool();
    proxyPool = new ProxyPool();
    app = createProxyRoutes(proxyPool, accountPool);
  });

  afterEach(() => {
    accountPool.destroy();
    proxyPool.destroy();
  });

  it("GET /api/proxies/assignments/export returns empty array when no assignments exist", async () => {
    accountPool.addAccount("token-empty-1");

    const res = await app.request("/api/proxies/assignments/export");

    expect(res.status).toBe(200);
    const data = await res.json() as { assignments: Array<{ email: string; proxyId: string }> };
    expect(data.assignments).toEqual([]);
    expect(proxyPool.getAllAssignments()).toEqual([]);
  });

  it("GET /api/proxies/assignments/export returns stable email + proxyId shape for explicit assignments only", async () => {
    const accountId1 = accountPool.addAccount("token-export-1");
    accountPool.addAccount("token-export-2");
    const proxyId = proxyPool.add("proxy-export", "http://127.0.0.1:8401");

    proxyPool.assign(accountId1, proxyId);

    const res = await app.request("/api/proxies/assignments/export");

    expect(res.status).toBe(200);
    const data = await res.json() as { assignments: Array<Record<string, string>> };
    expect(data.assignments).toEqual([
      {
        email: "token-export-1@test.com",
        proxyId,
      },
    ]);
    expect(Object.keys(data.assignments[0]).sort()).toEqual(["email", "proxyId"]);
  });

  it("POST /api/proxies/assignments/import previews changes and unchanged, skips unknown email, and does not apply", async () => {
    const accountId1 = accountPool.addAccount("token-preview-1");
    const accountId2 = accountPool.addAccount("token-preview-2");
    const proxyId1 = proxyPool.add("proxy-preview-1", "http://127.0.0.1:8402");
    const proxyId2 = proxyPool.add("proxy-preview-2", "http://127.0.0.1:8403");

    proxyPool.assign(accountId1, proxyId1);
    proxyPool.assign(accountId2, proxyId2);

    const res = await app.request("/api/proxies/assignments/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: [
          { email: "token-preview-1@test.com", proxyId: proxyId2 },
          { email: "token-preview-2@test.com", proxyId: proxyId2 },
          { email: "missing@test.com", proxyId: proxyId1 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as {
      changes: Array<{ email: string; accountId: string; from: string; to: string }>;
      unchanged: number;
    };
    expect(data.changes).toEqual([
      {
        email: "token-preview-1@test.com",
        accountId: accountId1,
        from: proxyId1,
        to: proxyId2,
      },
    ]);
    expect(data.unchanged).toBe(1);
    expect(proxyPool.getAssignment(accountId1)).toBe(proxyId1);
    expect(proxyPool.getAssignment(accountId2)).toBe(proxyId2);
    expect(proxyPool.getAllAssignments()).toEqual([
      { accountId: accountId1, proxyId: proxyId1 },
      { accountId: accountId2, proxyId: proxyId2 },
    ]);
  });

  it("POST /api/proxies/assignments/apply persists valid assignments", async () => {
    const accountId1 = accountPool.addAccount("token-apply-1");
    const accountId2 = accountPool.addAccount("token-apply-2");
    const proxyId = proxyPool.add("proxy-apply", "http://127.0.0.1:8404");

    const res = await app.request("/api/proxies/assignments/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: [
          { accountId: accountId1, proxyId },
          { accountId: accountId2, proxyId: "direct" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; applied: number };
    expect(data.success).toBe(true);
    expect(data.applied).toBe(2);
    expect(proxyPool.getAssignment(accountId1)).toBe(proxyId);
    expect(proxyPool.getAssignment(accountId2)).toBe("direct");
    expect(proxyPool.getAllAssignments()).toEqual([
      { accountId: accountId1, proxyId },
      { accountId: accountId2, proxyId: "direct" },
    ]);
  });

  it("POST /api/proxies/assignments/apply rejects invalid proxyId", async () => {
    const accountId = accountPool.addAccount("token-apply-invalid");

    const res = await app.request("/api/proxies/assignments/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: [{ accountId, proxyId: "missing-proxy" }],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('Invalid proxyId: "missing-proxy"');
    expect(proxyPool.getAssignment(accountId)).toBe("global");
    expect(proxyPool.getAllAssignments()).toEqual([]);
  });

  it("POST /api/proxies/assignments/apply rejects empty assignments", async () => {
    const res = await app.request("/api/proxies/assignments/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignments: [] }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain("assignments array is required and must not be empty");
  });

  it("POST /api/proxies/assign-bulk applies multiple accounts including global/direct/auto", async () => {
    const accountId1 = accountPool.addAccount("token-bulk-1");
    const accountId2 = accountPool.addAccount("token-bulk-2");
    const accountId3 = accountPool.addAccount("token-bulk-3");
    const accountId4 = accountPool.addAccount("token-bulk-4");
    const proxyId = proxyPool.add("proxy-bulk", "http://127.0.0.1:8405");

    const res = await app.request("/api/proxies/assign-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: [
          { accountId: accountId1, proxyId },
          { accountId: accountId2, proxyId: "global" },
          { accountId: accountId3, proxyId: "direct" },
          { accountId: accountId4, proxyId: "auto" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; applied: number };
    expect(data.success).toBe(true);
    expect(data.applied).toBe(4);
    expect(proxyPool.getAssignment(accountId1)).toBe(proxyId);
    expect(proxyPool.getAssignment(accountId2)).toBe("global");
    expect(proxyPool.getAssignment(accountId3)).toBe("direct");
    expect(proxyPool.getAssignment(accountId4)).toBe("auto");
    expect(proxyPool.getAllAssignments()).toEqual([
      { accountId: accountId1, proxyId },
      { accountId: accountId2, proxyId: "global" },
      { accountId: accountId3, proxyId: "direct" },
      { accountId: accountId4, proxyId: "auto" },
    ]);
  });

  it("export -> import preview -> apply -> export completes a minimal assignment round-trip", async () => {
    const accountId1 = accountPool.addAccount("token-roundtrip-1");
    const accountId2 = accountPool.addAccount("token-roundtrip-2");
    const proxyId1 = proxyPool.add("proxy-roundtrip-1", "http://127.0.0.1:8406");
    const proxyId2 = proxyPool.add("proxy-roundtrip-2", "http://127.0.0.1:8407");

    proxyPool.assign(accountId1, proxyId1);

    const exportBeforeRes = await app.request("/api/proxies/assignments/export");
    expect(exportBeforeRes.status).toBe(200);
    const exportedBefore = await exportBeforeRes.json() as {
      assignments: Array<{ email: string; proxyId: string }>;
    };
    expect(exportedBefore.assignments).toEqual([
      { email: "token-roundtrip-1@test.com", proxyId: proxyId1 },
    ]);

    const previewRes = await app.request("/api/proxies/assignments/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: [
          { email: "token-roundtrip-1@test.com", proxyId: proxyId2 },
          { email: "token-roundtrip-2@test.com", proxyId: "auto" },
        ],
      }),
    });
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json() as {
      changes: Array<{ email: string; accountId: string; from: string; to: string }>;
      unchanged: number;
    };
    expect(preview.unchanged).toBe(0);
    expect(preview.changes).toEqual([
      {
        email: "token-roundtrip-1@test.com",
        accountId: accountId1,
        from: proxyId1,
        to: proxyId2,
      },
      {
        email: "token-roundtrip-2@test.com",
        accountId: accountId2,
        from: "global",
        to: "auto",
      },
    ]);
    expect(proxyPool.getAssignment(accountId1)).toBe(proxyId1);
    expect(proxyPool.getAssignment(accountId2)).toBe("global");

    const applyRes = await app.request("/api/proxies/assignments/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: preview.changes.map(({ accountId, to }) => ({ accountId, proxyId: to })),
      }),
    });
    expect(applyRes.status).toBe(200);
    const applyData = await applyRes.json() as { success: boolean; applied: number };
    expect(applyData.success).toBe(true);
    expect(applyData.applied).toBe(2);
    expect(proxyPool.getAssignment(accountId1)).toBe(proxyId2);
    expect(proxyPool.getAssignment(accountId2)).toBe("auto");

    const exportAfterRes = await app.request("/api/proxies/assignments/export");
    expect(exportAfterRes.status).toBe(200);
    const exportedAfter = await exportAfterRes.json() as {
      assignments: Array<{ email: string; proxyId: string }>;
    };
    expect(exportedAfter.assignments).toEqual([
      { email: "token-roundtrip-1@test.com", proxyId: proxyId2 },
      { email: "token-roundtrip-2@test.com", proxyId: "auto" },
    ]);
  });
});
