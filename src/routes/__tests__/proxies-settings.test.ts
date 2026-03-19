/**
 * Tests for proxy settings endpoints.
 * GET /api/proxies — read current proxy settings
 * PUT /api/proxies/settings — update proxy settings
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
  getDataDir: vi.fn(() => "/tmp/test-proxy-settings-data"),
  getConfigDir: vi.fn(() => "/tmp/test-proxy-settings-config"),
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

describe("proxy settings endpoints", () => {
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

  it("reads the default health check interval from GET /api/proxies", async () => {
    const res = await app.request("/api/proxies");

    expect(res.status).toBe(200);
    const data = await res.json() as {
      healthCheckIntervalMinutes: number;
      proxies: unknown[];
      assignments: unknown[];
    };

    expect(data.healthCheckIntervalMinutes).toBe(5);
    expect(data.proxies).toEqual([]);
    expect(data.assignments).toEqual([]);
    expect(proxyPool.getHealthIntervalMinutes()).toBe(5);
  });

  it("updates interval and exposes the new value on subsequent reads", async () => {
    const updateRes = await app.request("/api/proxies/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ healthCheckIntervalMinutes: 12 }),
    });

    expect(updateRes.status).toBe(200);
    const updateData = await updateRes.json() as {
      success: boolean;
      healthCheckIntervalMinutes: number;
    };
    expect(updateData.success).toBe(true);
    expect(updateData.healthCheckIntervalMinutes).toBe(12);
    expect(proxyPool.getHealthIntervalMinutes()).toBe(12);

    const readRes = await app.request("/api/proxies");
    expect(readRes.status).toBe(200);
    const readData = await readRes.json() as { healthCheckIntervalMinutes: number };
    expect(readData.healthCheckIntervalMinutes).toBe(12);
  });

  it("clamps invalid interval values to the current minimum semantics", async () => {
    const updateRes = await app.request("/api/proxies/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ healthCheckIntervalMinutes: 0 }),
    });

    expect(updateRes.status).toBe(200);
    const updateData = await updateRes.json() as {
      success: boolean;
      healthCheckIntervalMinutes: number;
    };
    expect(updateData.success).toBe(true);
    expect(updateData.healthCheckIntervalMinutes).toBe(1);
    expect(proxyPool.getHealthIntervalMinutes()).toBe(1);

    const readRes = await app.request("/api/proxies");
    const readData = await readRes.json() as { healthCheckIntervalMinutes: number };
    expect(readData.healthCheckIntervalMinutes).toBe(1);
  });
});
