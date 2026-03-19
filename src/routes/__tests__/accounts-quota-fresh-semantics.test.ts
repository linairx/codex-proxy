/**
 * Tests for GET /auth/accounts?quota=fresh semantics alignment with background refresher.
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
  server: { proxy_api_key: null as string | null, port: 3000 },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
};

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-accounts-quota-fresh-data"),
  getConfigDir: vi.fn(() => "/tmp/test-accounts-quota-fresh-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
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

const mockGetUsage = vi.fn();

vi.mock("../../proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation(() => ({
    getUsage: mockGetUsage,
  })),
}));

import { Hono } from "hono";
import { AccountPool } from "../../auth/account-pool.js";
import { clearWarnings, getActiveWarnings } from "../../auth/quota-warnings.js";
import { createAccountRoutes } from "../../routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

function makeUsage(options: {
  primaryUsed: number | null;
  primaryResetAt?: number | null;
  primaryLimitReached?: boolean;
  secondaryUsed?: number | null;
  secondaryResetAt?: number | null;
  secondaryLimitReached?: boolean;
}) {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: options.primaryLimitReached ?? false,
      primary_window: {
        used_percent: options.primaryUsed,
        reset_at: options.primaryResetAt ?? 2000000000,
        limit_window_seconds: 3600,
      },
      secondary_window:
        options.secondaryUsed === undefined
          ? null
          : {
              used_percent: options.secondaryUsed,
              reset_at: options.secondaryResetAt ?? 2000003600,
              limit_window_seconds: 86400,
            },
    },
    code_review_rate_limit: null,
  };
}

describe("GET /auth/accounts?quota=fresh", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const warning of getActiveWarnings()) {
      clearWarnings(warning.accountId);
    }
    mockConfig.quota.skip_exhausted = true;
    pool = new AccountPool();
    app = new Hono();
    app.route("/", createAccountRoutes(pool, mockScheduler as never));
  });

  afterEach(() => {
    pool.destroy();
  });

  it("marks primary exhausted accounts as rate_limited and stores warnings during fresh fetch", async () => {
    const id = pool.addAccount("token-fresh-primary-exhausted");
    mockGetUsage.mockResolvedValueOnce(
      makeUsage({
        primaryUsed: 100,
        primaryResetAt: 2000000000,
        primaryLimitReached: true,
      }),
    );

    const res = await app.request("/auth/accounts?quota=fresh");
    expect(res.status).toBe(200);
    const data = await res.json() as {
      accounts: Array<{
        id: string;
        status: string;
        quota?: { rate_limit: { limit_reached: boolean; used_percent: number | null; reset_at: number | null } };
        usage: { rate_limit_until: string | null };
      }>;
    };

    const account = data.accounts.find((item) => item.id === id);
    expect(account).toMatchObject({
      id,
      status: "rate_limited",
      quota: {
        rate_limit: {
          limit_reached: true,
          used_percent: 100,
          reset_at: 2000000000,
        },
      },
    });
    expect(account?.usage.rate_limit_until).toBe(new Date(2000000000 * 1000).toISOString());
    expect(pool.getEntry(id)?.status).toBe("rate_limited");
    expect(getActiveWarnings()).toEqual([
      expect.objectContaining({
        accountId: id,
        window: "primary",
        level: "critical",
        usedPercent: 100,
        resetAt: 2000000000,
      }),
    ]);
  });

  it("uses secondary exhausted reset time when secondary window is exhausted during fresh fetch", async () => {
    const id = pool.addAccount("token-fresh-secondary-exhausted");
    mockGetUsage.mockResolvedValueOnce(
      makeUsage({
        primaryUsed: 40,
        primaryResetAt: 2000000000,
        primaryLimitReached: false,
        secondaryUsed: 100,
        secondaryResetAt: 2000007200,
        secondaryLimitReached: true,
      }),
    );

    const res = await app.request("/auth/accounts?quota=fresh");
    expect(res.status).toBe(200);
    const data = await res.json() as {
      accounts: Array<{ id: string; status: string; usage: { rate_limit_until: string | null } }>;
    };

    const account = data.accounts.find((item) => item.id === id);
    expect(account?.status).toBe("rate_limited");
    expect(account?.usage.rate_limit_until).toBe(new Date(2000007200 * 1000).toISOString());
    expect(getActiveWarnings()).toEqual([
      expect.objectContaining({
        accountId: id,
        window: "secondary",
        level: "critical",
        usedPercent: 100,
        resetAt: 2000007200,
      }),
    ]);
  });

  it("preserves disabled status and skips live quota fetch for disabled accounts", async () => {
    const id = pool.addAccount("token-fresh-disabled");
    pool.markStatus(id, "disabled");

    const res = await app.request("/auth/accounts?quota=fresh");
    expect(res.status).toBe(200);
    const data = await res.json() as {
      accounts: Array<{ id: string; status: string; quota?: unknown }>;
    };

    const account = data.accounts.find((item) => item.id === id);
    expect(account).toMatchObject({ id, status: "disabled" });
    expect(account?.quota).toBeUndefined();
    expect(mockGetUsage).not.toHaveBeenCalled();
    expect(getActiveWarnings()).toEqual([]);
  });
});
