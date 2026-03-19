/**
 * Tests for quota warnings route + manual refresh linkage.
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
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
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
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
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
import { clearWarnings, getActiveWarnings, getWarningsLastUpdated } from "../../auth/quota-warnings.js";
import { createAccountRoutes } from "../../routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

function makeUsage(options: {
  primaryUsed: number | null;
  secondaryUsed?: number | null;
  primaryResetAt?: number | null;
  secondaryResetAt?: number | null;
  limitReached?: boolean;
}) {
  return {
    plan_type: "free",
    rate_limit: {
      allowed: true,
      limit_reached: options.limitReached ?? false,
      primary_window: {
        used_percent: options.primaryUsed,
        reset_at: options.primaryResetAt ?? 1700000000,
        limit_window_seconds: 3600,
      },
      secondary_window:
        options.secondaryUsed === undefined
          ? null
          : {
              used_percent: options.secondaryUsed,
              reset_at: options.secondaryResetAt ?? 1700003600,
              limit_window_seconds: 86400,
            },
    },
    code_review_rate_limit: null,
  };
}

describe("quota warnings route", () => {
  let pool: AccountPool;
  let app: Hono;
  let accountId: string;

  beforeEach(() => {
    vi.clearAllMocks();

    for (const warning of getActiveWarnings()) {
      clearWarnings(warning.accountId);
    }

    mockConfig.quota.warning_thresholds = { primary: [80, 90], secondary: [80, 90] };

    pool = new AccountPool();
    accountId = pool.addAccount("tokenAAAA1234567890");

    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);
  });

  afterEach(() => {
    pool.destroy();
  });

  it("updates warnings store after manual fresh refresh and route returns latest warning", async () => {
    mockGetUsage.mockResolvedValueOnce(makeUsage({ primaryUsed: 85 }));

    const refreshRes = await app.request("/auth/accounts?quota=fresh");
    expect(refreshRes.status).toBe(200);

    const res = await app.request("/auth/quota/warnings");
    expect(res.status).toBe(200);
    const data = await res.json() as {
      warnings: Array<{ accountId: string; level: string; window: string; usedPercent: number }>;
      updatedAt: string | null;
    };

    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toMatchObject({
      accountId,
      level: "warning",
      window: "primary",
      usedPercent: 85,
    });
    expect(data.updatedAt).toEqual(getWarningsLastUpdated());
    expect(typeof data.updatedAt).toBe("string");
  });

  it("tracks empty -> warning -> critical -> cleared state evolution via refresh route", async () => {
    mockGetUsage
      .mockResolvedValueOnce(makeUsage({ primaryUsed: 50 }))
      .mockResolvedValueOnce(makeUsage({ primaryUsed: 85 }))
      .mockResolvedValueOnce(makeUsage({ primaryUsed: 95 }))
      .mockResolvedValueOnce(makeUsage({ primaryUsed: 20 }));

    await app.request("/auth/accounts?quota=fresh");
    let res = await app.request("/auth/quota/warnings");
    let data = await res.json() as { warnings: Array<{ level: string; usedPercent: number }> };
    expect(data.warnings).toEqual([]);

    await app.request("/auth/accounts?quota=fresh");
    res = await app.request("/auth/quota/warnings");
    data = await res.json();
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toMatchObject({ level: "warning", usedPercent: 85 });

    await app.request("/auth/accounts?quota=fresh");
    res = await app.request("/auth/quota/warnings");
    data = await res.json();
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toMatchObject({ level: "critical", usedPercent: 95 });

    await app.request("/auth/accounts?quota=fresh");
    res = await app.request("/auth/quota/warnings");
    data = await res.json();
    expect(data.warnings).toEqual([]);
  });

  it("returns simultaneous primary and secondary warnings for one account", async () => {
    mockGetUsage.mockResolvedValueOnce(
      makeUsage({
        primaryUsed: 85,
        secondaryUsed: 95,
        primaryResetAt: 1700000000,
        secondaryResetAt: 1700003600,
      }),
    );

    await app.request("/auth/accounts?quota=fresh");
    const res = await app.request("/auth/quota/warnings");
    const data = await res.json() as {
      warnings: Array<{ window: string; level: string; usedPercent: number; resetAt: number | null }>;
    };

    expect(data.warnings).toHaveLength(2);
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ window: "primary", level: "warning", usedPercent: 85, resetAt: 1700000000 }),
        expect.objectContaining({ window: "secondary", level: "critical", usedPercent: 95, resetAt: 1700003600 }),
      ]),
    );
  });

  it("keeps updatedAt stable and readable as an ISO timestamp", async () => {
    mockGetUsage
      .mockResolvedValueOnce(makeUsage({ primaryUsed: 85 }))
      .mockResolvedValueOnce(makeUsage({ primaryUsed: 95 }));

    await app.request("/auth/accounts?quota=fresh");
    const first = await (await app.request("/auth/quota/warnings")).json() as { updatedAt: string | null };
    expect(first.updatedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(first.updatedAt!))).toBe(false);

    await app.request("/auth/accounts?quota=fresh");
    const second = await (await app.request("/auth/quota/warnings")).json() as {
      updatedAt: string | null;
      warnings: Array<{ level: string }>;
    };

    expect(second.updatedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(second.updatedAt!))).toBe(false);
    expect(Date.parse(second.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt!));
    expect(second.warnings[0]?.level).toBe("critical");
  });
});
