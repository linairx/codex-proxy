/**
 * Tests for proxy update endpoint.
 * PUT /api/proxies/:id — update proxy fields and side effects
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
  getDataDir: vi.fn(() => "/tmp/test-proxy-update-data"),
  getConfigDir: vi.fn(() => "/tmp/test-proxy-update-config"),
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
import type { ProxyHealthInfo } from "../../proxy/proxy-pool.js";
import { AccountPool } from "../../auth/account-pool.js";
import { ProxyPool } from "../../proxy/proxy-pool.js";
import { createProxyRoutes } from "../proxies.js";

describe("PUT /api/proxies/:id", () => {
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

  it("updates only the proxy name", async () => {
    const proxyId = proxyPool.add("proxy-old", "http://127.0.0.1:9001");

    const res = await app.request(`/api/proxies/${proxyId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "proxy-renamed" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as {
      success: boolean;
      proxy: { id: string; name: string; url: string };
    };
    expect(data.success).toBe(true);
    expect(data.proxy).toMatchObject({
      id: proxyId,
      name: "proxy-renamed",
      url: "http://127.0.0.1:9001",
    });

    const stored = proxyPool.getById(proxyId);
    expect(stored?.name).toBe("proxy-renamed");
    expect(stored?.url).toBe("http://127.0.0.1:9001");
  });

  it("updates only the proxy url and resets health/status side effects", async () => {
    const proxyId = proxyPool.add("proxy-url", "http://127.0.0.1:9002");
    const proxy = proxyPool.getById(proxyId);
    const previousHealth: ProxyHealthInfo = {
      exitIp: "1.2.3.4",
      latencyMs: 123,
      lastChecked: new Date().toISOString(),
      error: "timeout",
    };

    if (!proxy) throw new Error("expected proxy to exist");
    proxy.status = "unreachable";
    proxy.health = previousHealth;

    const res = await app.request(`/api/proxies/${proxyId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9102" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as {
      success: boolean;
      proxy: { id: string; name: string; url: string; status: string; health: null };
    };
    expect(data.success).toBe(true);
    expect(data.proxy).toMatchObject({
      id: proxyId,
      name: "proxy-url",
      url: "http://127.0.0.1:9102",
      status: "active",
      health: null,
    });

    const stored = proxyPool.getById(proxyId);
    expect(stored?.url).toBe("http://127.0.0.1:9102");
    expect(stored?.status).toBe("active");
    expect(stored?.health).toBeNull();
  });

  it("updates both name and url and exposes the latest values in the list endpoint", async () => {
    const proxyId = proxyPool.add("proxy-both-old", "http://127.0.0.1:9003");

    const updateRes = await app.request(`/api/proxies/${proxyId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "proxy-both-new",
        url: "http://127.0.0.1:9103",
      }),
    });

    expect(updateRes.status).toBe(200);
    const updateData = await updateRes.json() as {
      proxy: { id: string; name: string; url: string };
    };
    expect(updateData.proxy).toMatchObject({
      id: proxyId,
      name: "proxy-both-new",
      url: "http://127.0.0.1:9103",
    });

    const listRes = await app.request("/api/proxies");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      proxies: Array<{ id: string; name: string; url: string }>;
    };
    expect(listData.proxies).toContainEqual(expect.objectContaining({
      id: proxyId,
      name: "proxy-both-new",
      url: "http://127.0.0.1:9103/",
    }));
  });

  it("updates assigned account resolution to the latest proxy URL", async () => {
    const accountId = accountPool.addAccount("token-update-bound-url");
    const proxyId = proxyPool.add("proxy-update-bound-url", "http://127.0.0.1:9004");
    proxyPool.assign(accountId, proxyId);

    const res = await app.request(`/api/proxies/${proxyId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9104" }),
    });

    expect(res.status).toBe(200);
    expect(proxyPool.resolveProxyUrl(accountId)).toBe("http://127.0.0.1:9104");
  });

  it("returns a stable not-found error for unknown proxy ids", async () => {
    const res = await app.request("/api/proxies/missing-proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "does-not-matter" }),
    });

    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("Proxy not found");
  });
});
