/**
 * Tests that deleting an account also removes orphaned proxy assignments
 * from route/list/export surfaces while keeping proxy configuration intact.
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
  getDataDir: vi.fn(() => "/tmp/test-account-delete-assignment-data"),
  getConfigDir: vi.fn(() => "/tmp/test-account-delete-assignment-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null, port: 3000 },
    quota: {
      refresh_interval_minutes: 5,
      warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
      skip_exhausted: true,
    },
  })),
}));

vi.mock("../../auth/chatgpt-oauth.js", () => ({
  validateManualToken: vi.fn(() => ({ valid: true })),
}));

vi.mock("../../auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(() => ({ authUrl: "https://example.com/oauth" })),
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
import { clearWarnings, getActiveWarnings, updateWarnings } from "../../auth/quota-warnings.js";
import { ProxyPool } from "../../proxy/proxy-pool.js";
import { createAccountRoutes } from "../../routes/accounts.js";
import { createProxyRoutes } from "../../routes/proxies.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("account deletion clears orphaned proxy assignments", () => {
  let accountPool: AccountPool;
  let proxyPool: ProxyPool;
  let accountsApp: Hono;
  let proxiesApp: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const warning of getActiveWarnings()) {
      clearWarnings(warning.accountId);
    }
    accountPool = new AccountPool();
    proxyPool = new ProxyPool();
    accountsApp = new Hono();
    accountsApp.route("/", createAccountRoutes(accountPool, mockScheduler as never, undefined, proxyPool));
    proxiesApp = createProxyRoutes(proxyPool, accountPool);
  });

  afterEach(() => {
    accountPool.destroy();
    proxyPool.destroy();
  });

  it("removes warnings and explicit assignment from proxy list and export after account deletion", async () => {
    const accountId = accountPool.addAccount("token-delete-assignment-1");
    const retainedAccountId = accountPool.addAccount("token-delete-assignment-2");
    const proxyId = proxyPool.add("proxy-delete-assignment", "http://127.0.0.1:8501");

    proxyPool.assign(accountId, proxyId);
    proxyPool.assign(retainedAccountId, "direct");
    updateWarnings(accountId, [
      {
        accountId,
        email: "token-delete-assignment-1@test.com",
        window: "primary",
        level: "critical",
        usedPercent: 99,
        resetAt: 1700000000,
      },
    ]);

    const beforeList = await proxiesApp.request("/api/proxies");
    const beforeListData = await beforeList.json() as {
      assignments: Array<{ accountId: string; proxyId: string }>;
    };
    expect(beforeListData.assignments).toEqual([
      { accountId, proxyId },
      { accountId: retainedAccountId, proxyId: "direct" },
    ]);

    const delRes = await accountsApp.request(`/auth/accounts/${accountId}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(getActiveWarnings().some((w) => w.accountId === accountId)).toBe(false);

    const listRes = await proxiesApp.request("/api/proxies");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      assignments: Array<{ accountId: string; proxyId: string }>;
      proxies: Array<{ id: string; name: string }>;
    };
    expect(listData.proxies).toEqual([
      expect.objectContaining({ id: proxyId, name: "proxy-delete-assignment" }),
    ]);
    expect(listData.assignments).toEqual([
      { accountId: retainedAccountId, proxyId: "direct" },
    ]);

    const exportRes = await proxiesApp.request("/api/proxies/assignments/export");
    expect(exportRes.status).toBe(200);
    const exportData = await exportRes.json() as {
      assignments: Array<{ email: string; proxyId: string; resolvedProxyId: string; resolvedProxyName: string }>;
    };
    expect(exportData.assignments).toEqual([
      {
        email: "token-delete-assignment-2@test.com",
        proxyId: "direct",
        resolvedProxyId: "direct",
        resolvedProxyName: "Direct (No Proxy)",
      },
    ]);

    const assignmentListRes = await proxiesApp.request("/api/proxies/assignments");
    expect(assignmentListRes.status).toBe(200);
    const assignmentListData = await assignmentListRes.json() as {
      accounts: Array<{ id: string; proxyId: string }>;
    };
    expect(assignmentListData.accounts.map((account) => account.id)).toEqual([retainedAccountId]);
    expect(assignmentListData.accounts[0]).toMatchObject({
      id: retainedAccountId,
      proxyId: "direct",
    });
  });
});
