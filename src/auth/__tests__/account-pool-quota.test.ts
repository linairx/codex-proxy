/**
 * Tests for AccountPool quota-related methods:
 * - updateCachedQuota()
 * - markQuotaExhausted()
 * - toInfo() populating cached quota
 * - loadPersisted() backfill
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null },
    quota: {
      refresh_interval_minutes: 5,
      warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
      skip_exhausted: true,
    },
  })),
}));

// Use a counter to generate unique accountIds
let _idCounter = 0;
vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn(() => `acct-${++_idCounter}`),
  extractUserProfile: vi.fn(() => ({
    email: `user${_idCounter}@test.com`,
    chatgpt_plan_type: "plus",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

import { AccountPool } from "../account-pool.js";
import type { CodexQuota } from "../types.js";

function makeQuota(overrides?: Partial<CodexQuota>): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 42,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

describe("AccountPool quota methods", () => {
  let pool: AccountPool;

  beforeEach(() => {
    pool = new AccountPool();
  });

  describe("updateCachedQuota", () => {
    it("stores quota and timestamp on account", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-aaa");
      const quota = makeQuota();

      pool.updateCachedQuota(id, quota);

      const entry = pool.getEntry(id);
      expect(entry?.cachedQuota).toEqual(quota);
      expect(entry?.quotaFetchedAt).toBeTruthy();
    });

    it("no-ops for unknown entry", () => {
      // Should not throw
      pool.updateCachedQuota("nonexistent", makeQuota());
    });
  });

  describe("markQuotaExhausted", () => {
    it("sets status to rate_limited with reset time", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-bbb");
      const resetAt = Math.floor(Date.now() / 1000) + 7200;

      pool.markQuotaExhausted(id, resetAt);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("rate_limited");
      expect(entry?.usage.rate_limit_until).toBeTruthy();
    });

    it("uses fallback when resetAt is null", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-ccc");

      pool.markQuotaExhausted(id, null);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("rate_limited");
      expect(entry?.usage.rate_limit_until).toBeTruthy();
    });

    it("does not override disabled status", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-ddd");
      pool.markStatus(id, "disabled");

      pool.markQuotaExhausted(id, Math.floor(Date.now() / 1000) + 3600);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("disabled"); // unchanged
    });

    it("does not override expired status", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-ddd2");
      pool.markStatus(id, "expired");

      pool.markQuotaExhausted(id, Math.floor(Date.now() / 1000) + 3600);

      const entry = pool.getEntry(id);
      expect(entry?.status).toBe("expired"); // unchanged
    });

    it("extends rate_limit_until on already rate_limited account", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-ddd3");
      // Simulate 429 backoff (short)
      pool.markRateLimited(id, { retryAfterSec: 60 });
      const entryBefore = pool.getEntry(id);
      expect(entryBefore?.status).toBe("rate_limited");
      const shortUntil = new Date(entryBefore!.usage.rate_limit_until!).getTime();

      // Quota refresh discovers exhaustion — much longer reset
      const resetAt = Math.floor(Date.now() / 1000) + 7200; // 2 hours
      pool.markQuotaExhausted(id, resetAt);

      const entryAfter = pool.getEntry(id);
      expect(entryAfter?.status).toBe("rate_limited");
      const longUntil = new Date(entryAfter!.usage.rate_limit_until!).getTime();
      expect(longUntil).toBeGreaterThan(shortUntil);
    });

    it("does not shorten existing rate_limit_until", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-ddd4");
      // Mark with long reset (e.g. 7-day quota)
      const longResetAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours
      pool.markQuotaExhausted(id, longResetAt);

      const entryBefore = pool.getEntry(id);
      const originalUntil = entryBefore!.usage.rate_limit_until;

      // Try to mark with shorter reset (e.g. 5-hour quota)
      const shortResetAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      pool.markQuotaExhausted(id, shortResetAt);

      const entryAfter = pool.getEntry(id);
      expect(entryAfter!.usage.rate_limit_until).toBe(originalUntil); // unchanged
    });
  });

  describe("toInfo with cached quota", () => {
    it("populates quota field from cachedQuota", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-eee");
      const quota = makeQuota({ plan_type: "team" });

      pool.updateCachedQuota(id, quota);

      const accounts = pool.getAccounts();
      const acct = accounts.find((a) => a.id === id);
      expect(acct?.quota).toEqual(quota);
      expect(acct?.quotaFetchedAt).toBeTruthy();
    });

    it("does not include quota when cachedQuota is null", () => {
      const id = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-fff");

      const accounts = pool.getAccounts();
      const acct = accounts.find((a) => a.id === id);
      expect(acct?.quota).toBeUndefined();
    });
  });

  describe("acquire skips exhausted accounts", () => {
    it("skips rate_limited (quota exhausted) account", () => {
      const id1 = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-ggg");
      const id2 = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-hhh");

      // Exhaust first account
      pool.markQuotaExhausted(id1, Math.floor(Date.now() / 1000) + 7200);

      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.entryId).toBe(id2);
      pool.release(acquired!.entryId);
    });

    it("returns null when all accounts exhausted", () => {
      const id1 = pool.addAccount("eyJhbGciOiJIUzI1NiJ9.test-token-iii");
      pool.markQuotaExhausted(id1, Math.floor(Date.now() / 1000) + 7200);

      const acquired = pool.acquire();
      expect(acquired).toBeNull();
    });
  });
});
