/**
 * Tests for POST /auth/accounts/:id/disable and /enable semantics.
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
  getDataDir: vi.fn(() => "/tmp/test-accounts-enable-disable-data"),
  getConfigDir: vi.fn(() => "/tmp/test-accounts-enable-disable-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null, port: 3000 },
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
    chatgpt_plan_type: "plus",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

import { Hono } from "hono";
import { AccountPool } from "../../auth/account-pool.js";
import { createAccountRoutes } from "../../routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("POST /auth/accounts/:id/disable and /enable", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new AccountPool();
    app = new Hono();
    app.route("/", createAccountRoutes(pool, mockScheduler as never));
  });

  afterEach(() => {
    pool.destroy();
  });

  it("disables an account and keeps it out of scheduler selection", async () => {
    const id = pool.addAccount("token-enable-disable");

    const disableRes = await app.request(`/auth/accounts/${encodeURIComponent(id)}/disable`, {
      method: "POST",
    });

    expect(disableRes.status).toBe(200);
    expect(await disableRes.json()).toMatchObject({
      success: true,
      account: { id, status: "disabled" },
    });
    expect(pool.getEntry(id)?.status).toBe("disabled");
    expect(pool.acquire()).toBeNull();

    const listRes = await app.request("/auth/accounts");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      accounts: Array<{ id: string; status: string }>;
    };
    expect(listData.accounts.find((account) => account.id === id)).toMatchObject({
      id,
      status: "disabled",
    });
  });

  it("re-enables a disabled account and makes it selectable again", async () => {
    const id = pool.addAccount("token-enable-disable-recover");
    pool.markStatus(id, "disabled");

    expect(pool.acquire()).toBeNull();

    const enableRes = await app.request(`/auth/accounts/${encodeURIComponent(id)}/enable`, {
      method: "POST",
    });

    expect(enableRes.status).toBe(200);
    expect(await enableRes.json()).toMatchObject({
      success: true,
      account: { id, status: "active" },
    });
    expect(pool.getEntry(id)?.status).toBe("active");

    const acquired = pool.acquire();
    expect(acquired).toMatchObject({ entryId: id });
    pool.release(id);

    const listRes = await app.request("/auth/accounts");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      accounts: Array<{ id: string; status: string }>;
    };
    expect(listData.accounts.find((account) => account.id === id)).toMatchObject({
      id,
      status: "active",
    });
  });

  it("returns 404 when enabling or disabling a missing account", async () => {
    const missingId = "missing-account";

    const disableRes = await app.request(`/auth/accounts/${missingId}/disable`, {
      method: "POST",
    });
    expect(disableRes.status).toBe(404);
    expect(await disableRes.json()).toMatchObject({ error: "Account not found" });

    const enableRes = await app.request(`/auth/accounts/${missingId}/enable`, {
      method: "POST",
    });
    expect(enableRes.status).toBe(404);
    expect(await enableRes.json()).toMatchObject({ error: "Account not found" });
  });
});
