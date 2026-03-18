/**
 * Tests for proxy assign-rule endpoint.
 * POST /api/proxies/assign-rule — assign proxies to accounts by rule
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
  getDataDir: vi.fn(() => "/tmp/test-proxy-assign-rule-data"),
  getConfigDir: vi.fn(() => "/tmp/test-proxy-assign-rule-config"),
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

describe("POST /api/proxies/assign-rule", () => {
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

  it("assigns two accounts across two proxies with round-robin", async () => {
    const accountId1 = accountPool.addAccount("token-a1");
    const accountId2 = accountPool.addAccount("token-a2");
    const proxyId1 = proxyPool.add("proxy-1", "http://127.0.0.1:8001");
    const proxyId2 = proxyPool.add("proxy-2", "http://127.0.0.1:8002");

    const res = await app.request("/api/proxies/assign-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountIds: [accountId1, accountId2],
        rule: "round-robin",
        targetProxyIds: [proxyId1, proxyId2],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as {
      success: boolean;
      applied: number;
      assignments: Array<{ accountId: string; proxyId: string }>;
    };
    expect(data.success).toBe(true);
    expect(data.applied).toBe(2);
    expect(data.assignments).toEqual([
      { accountId: accountId1, proxyId: proxyId1 },
      { accountId: accountId2, proxyId: proxyId2 },
    ]);
    expect(proxyPool.getAssignment(accountId1)).toBe(proxyId1);
    expect(proxyPool.getAssignment(accountId2)).toBe(proxyId2);
  });

  it("cycles proxy assignments when accounts exceed proxies", async () => {
    const accountId1 = accountPool.addAccount("token-b1");
    const accountId2 = accountPool.addAccount("token-b2");
    const accountId3 = accountPool.addAccount("token-b3");
    const accountId4 = accountPool.addAccount("token-b4");
    const proxyId1 = proxyPool.add("proxy-1", "http://127.0.0.1:8101");
    const proxyId2 = proxyPool.add("proxy-2", "http://127.0.0.1:8102");

    const res = await app.request("/api/proxies/assign-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountIds: [accountId1, accountId2, accountId3, accountId4],
        rule: "round-robin",
        targetProxyIds: [proxyId1, proxyId2],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as {
      assignments: Array<{ accountId: string; proxyId: string }>;
    };
    expect(data.assignments).toEqual([
      { accountId: accountId1, proxyId: proxyId1 },
      { accountId: accountId2, proxyId: proxyId2 },
      { accountId: accountId3, proxyId: proxyId1 },
      { accountId: accountId4, proxyId: proxyId2 },
    ]);
  });

  it("rejects unsupported rules", async () => {
    const accountId = accountPool.addAccount("token-c1");
    const proxyId = proxyPool.add("proxy-1", "http://127.0.0.1:8201");

    const res = await app.request("/api/proxies/assign-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountIds: [accountId],
        rule: "random",
        targetProxyIds: [proxyId],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('Unsupported rule: "random"');
  });

  it("rejects unknown account ids", async () => {
    const proxyId = proxyPool.add("proxy-1", "http://127.0.0.1:8301");

    const res = await app.request("/api/proxies/assign-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountIds: ["missing-account"],
        rule: "round-robin",
        targetProxyIds: [proxyId],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('Invalid accountId: "missing-account"');
  });

  it("rejects unknown proxy ids", async () => {
    const accountId = accountPool.addAccount("token-d1");

    const res = await app.request("/api/proxies/assign-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountIds: [accountId],
        rule: "round-robin",
        targetProxyIds: ["missing-proxy"],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('Invalid targetProxyId: "missing-proxy"');
  });
});
