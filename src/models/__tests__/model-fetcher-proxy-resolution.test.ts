/**
 * Tests that background model refresh resolves proxy assignments before constructing CodexApi.
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
  getDataDir: vi.fn(() => "/tmp/test-model-fetcher-proxy-data"),
  getConfigDir: vi.fn(() => "/tmp/test-model-fetcher-proxy-config"),
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
    chatgpt_plan_type: "plus",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

const codexApiCtor = vi.fn();
const mockGetModels = vi.fn();

vi.mock("../../proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation((token, accountId, cookieJar, entryId, proxyUrl) => {
    codexApiCtor(token, accountId, cookieJar, entryId, proxyUrl);
    return { getModels: mockGetModels };
  }),
}));

import { AccountPool } from "../../auth/account-pool.js";
import { ProxyPool } from "../../proxy/proxy-pool.js";
import { getModelPlanTypes } from "../model-store.js";
import { startModelRefresh, stopModelRefresh } from "../model-fetcher.js";

function setPlanType(pool: AccountPool, entryId: string, planType: "free" | "plus" | "team") {
  const entry = pool.getEntry(entryId);
  if (!entry) throw new Error(`missing account ${entryId}`);
  entry.planType = planType;
}

describe("model fetcher proxy assignment forwarding", () => {
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
    mockGetModels.mockResolvedValue([{ slug: "gpt-5.2-codex", id: "gpt-5.2-codex", name: "gpt-5.2-codex" }]);
  });

  afterEach(() => {
    stopModelRefresh();
    pool.destroy();
    proxyPool.destroy();
    vi.useRealTimers();
  });

  it("passes the resolved assigned proxy URL into CodexApi during background model refresh", async () => {
    const entryId = pool.addAccount("token-model-proxy");
    setPlanType(pool, entryId, "plus");
    const proxyId = proxyPool.add("proxy-model", "http://127.0.0.1:8901");
    proxyPool.assign(entryId, proxyId);

    startModelRefresh(pool, cookieJar as never, proxyPool);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(codexApiCtor).toHaveBeenCalledTimes(1);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      cookieJar,
      entryId,
      "http://127.0.0.1:8901",
    );
    expect(getModelPlanTypes("gpt-5.2-codex")).toContain("plus");
  });

  it("falls back to global semantics when the configured proxy is disabled", async () => {
    const entryId = pool.addAccount("token-model-disabled");
    setPlanType(pool, entryId, "plus");
    const proxyId = proxyPool.add("proxy-model-disabled", "http://127.0.0.1:8902");
    proxyPool.assign(entryId, proxyId);
    proxyPool.disable(proxyId);

    startModelRefresh(pool, cookieJar as never, proxyPool);
    vi.advanceTimersByTime(1000);
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

  it("preserves direct semantics by forwarding null", async () => {
    const entryId = pool.addAccount("token-model-direct");
    setPlanType(pool, entryId, "plus");
    proxyPool.assign(entryId, "direct");

    startModelRefresh(pool, cookieJar as never, proxyPool);
    vi.advanceTimersByTime(1000);
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
});
