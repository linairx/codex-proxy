/**
 * Tests that background quota refresh resolves the current account proxy assignment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

const mockConfig = {
  auth: {
    jwt_token: null as string | null,
    rotation_strategy: "least_used",
    rate_limit_backoff_seconds: 60,
  },
  server: { proxy_api_key: null as string | null },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
};

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-usage-refresher-proxy-data"),
  getConfigDir: vi.fn(() => "/tmp/test-usage-refresher-proxy-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token}@test.com`,
    chatgpt_plan_type: "plus",
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

const mockGetUsage = vi.fn();
const codexApiCtor = vi.fn();

vi.mock("../../proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation((token, accountId, cookieJar, entryId, proxyUrl) => {
    codexApiCtor(token, accountId, cookieJar, entryId, proxyUrl);
    return { getUsage: mockGetUsage };
  }),
}));

import { AccountPool } from "../../auth/account-pool.js";
import { ProxyPool } from "../../proxy/proxy-pool.js";
import { startQuotaRefresh, stopQuotaRefresh } from "../../auth/usage-refresher.js";

function makeUsage() {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 10,
        reset_at: 2000000000,
        limit_window_seconds: 3600,
      },
      secondary_window: null,
    },
    code_review_rate_limit: null,
  };
}

describe("usage refresher proxy assignment forwarding", () => {
  let pool: AccountPool;
  let proxyPool: ProxyPool;
  const cookieJar = {
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    getCookieHeader: vi.fn(() => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    pool = new AccountPool();
    proxyPool = new ProxyPool();
    mockGetUsage.mockResolvedValue(makeUsage());
  });

  afterEach(() => {
    stopQuotaRefresh();
    pool.destroy();
    proxyPool.destroy();
    vi.useRealTimers();
  });

  it("passes the resolved assigned proxy URL into CodexApi during background refresh", async () => {
    const entryId = pool.addAccount("token-refresh-proxy");
    const proxyId = proxyPool.add("proxy-refresh", "http://127.0.0.1:8601");
    proxyPool.assign(entryId, proxyId);

    startQuotaRefresh(pool, cookieJar as never, proxyPool);
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();

    expect(codexApiCtor).toHaveBeenCalledTimes(1);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      cookieJar,
      entryId,
      "http://127.0.0.1:8601",
    );
  });

  it("falls back to global semantics when the configured proxy is disabled", async () => {
    const entryId = pool.addAccount("token-refresh-disabled");
    const proxyId = proxyPool.add("proxy-refresh-disabled", "http://127.0.0.1:8602");
    proxyPool.assign(entryId, proxyId);
    proxyPool.disable(proxyId);

    startQuotaRefresh(pool, cookieJar as never, proxyPool);
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();

    expect(codexApiCtor).toHaveBeenCalledTimes(1);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      cookieJar,
      entryId,
      undefined,
    );
  });

  it("preserves direct assignment semantics by forwarding null proxyUrl", async () => {
    const entryId = pool.addAccount("token-refresh-direct");
    proxyPool.assign(entryId, "direct");

    startQuotaRefresh(pool, cookieJar as never, proxyPool);
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();

    expect(codexApiCtor).toHaveBeenCalledTimes(1);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      cookieJar,
      entryId,
      null,
    );
  });

  it("resolves auto assignments to an active proxy URL during background refresh", async () => {
    const entryId = pool.addAccount("token-refresh-auto");
    proxyPool.add("proxy-refresh-auto-1", "http://127.0.0.1:8603");
    proxyPool.add("proxy-refresh-auto-2", "http://127.0.0.1:8604");
    proxyPool.assign(entryId, "auto");

    startQuotaRefresh(pool, cookieJar as never, proxyPool);
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();

    expect(codexApiCtor).toHaveBeenCalledTimes(1);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      cookieJar,
      entryId,
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:860[34]$/),
    );
  });
});
