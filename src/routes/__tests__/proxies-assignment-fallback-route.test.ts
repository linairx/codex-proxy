/**
 * Tests for route/export fallback semantics when configured proxy bindings are no longer usable.
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
  getDataDir: vi.fn(() => "/tmp/test-proxy-assignment-fallback-data"),
  getConfigDir: vi.fn(() => "/tmp/test-proxy-assignment-fallback-config"),
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

vi.mock("../../tls/transport.js", () => ({
  getTransport: vi.fn(),
  getTransportInfo: vi.fn(() => ({})),
}));

import { Hono } from "hono";
import { AccountPool } from "../../auth/account-pool.js";
import { ProxyPool } from "../../proxy/proxy-pool.js";
import { createProxyRoutes } from "../proxies.js";

describe("proxy assignment fallback route semantics", () => {
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

  it("keeps configured proxy binding while exposing global fallback after the proxy is disabled", async () => {
    const accountId = accountPool.addAccount("token-route-disabled");
    const proxyId = proxyPool.add("proxy-route-disabled", "http://127.0.0.1:8701");
    proxyPool.assign(accountId, proxyId);
    proxyPool.disable(proxyId);

    const listRes = await app.request("/api/proxies/assignments");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      accounts: Array<{
        id: string;
        proxyId: string;
        proxyName: string;
        resolvedProxyId?: string;
        resolvedProxyName?: string;
      }>;
    };
    expect(listData.accounts).toContainEqual(expect.objectContaining({
      id: accountId,
      proxyId,
      proxyName: "proxy-route-disabled",
      resolvedProxyId: "global",
      resolvedProxyName: "Global Default",
    }));

    const exportRes = await app.request("/api/proxies/assignments/export");
    expect(exportRes.status).toBe(200);
    const exportData = await exportRes.json() as {
      assignments: Array<{
        email: string;
        proxyId: string;
        resolvedProxyId?: string;
        resolvedProxyName?: string;
      }>;
    };
    expect(exportData.assignments).toEqual([
      {
        email: "token-route-disabled@test.com",
        proxyId,
        resolvedProxyId: "global",
        resolvedProxyName: "Global Default",
      },
    ]);
  });

  it("drops stored assignment after proxy deletion and surfaces the account as global", async () => {
    const accountId = accountPool.addAccount("token-route-deleted");
    const proxyId = proxyPool.add("proxy-route-deleted", "http://127.0.0.1:8702");
    proxyPool.assign(accountId, proxyId);

    const deleteRes = await app.request(`/api/proxies/${proxyId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    expect(proxyPool.getAssignment(accountId)).toBe("global");
    expect(proxyPool.getAllAssignments()).toEqual([]);

    const listRes = await app.request("/api/proxies/assignments");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      accounts: Array<{ id: string; proxyId: string; proxyName: string; resolvedProxyId?: string }>;
    };
    expect(listData.accounts).toContainEqual(expect.objectContaining({
      id: accountId,
      proxyId: "global",
      proxyName: "Global Default",
      resolvedProxyId: "global",
    }));

    const exportRes = await app.request("/api/proxies/assignments/export");
    expect(exportRes.status).toBe(200);
    const exportData = await exportRes.json() as {
      assignments: Array<{ email: string; proxyId: string }>;
    };
    expect(exportData.assignments).toEqual([]);
  });
});
