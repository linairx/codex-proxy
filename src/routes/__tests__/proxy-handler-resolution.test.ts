/**
 * Tests that the shared proxy handler forwards resolved proxy semantics into CodexApi.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-proxy-handler-resolution-data"),
  getConfigDir: vi.fn(() => "/tmp/test-proxy-handler-resolution-config"),
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

const codexApiCtor = vi.fn();
const mockCreateResponse = vi.fn();

vi.mock("../../proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation((token, accountId, cookieJar, entryId, proxyUrl) => {
    codexApiCtor(token, accountId, cookieJar, entryId, proxyUrl);
    return { createResponse: mockCreateResponse };
  }),
  CodexApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      super(body);
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock("../../utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { AccountPool } from "../../auth/account-pool.js";
import { ProxyPool } from "../../proxy/proxy-pool.js";
import {
  handleProxyRequest,
  type FormatAdapter,
  type ProxyRequest,
} from "../shared/proxy-handler.ts";

function createTestFormat(): FormatAdapter {
  return {
    tag: "Test",
    noAccountStatus: 503 as StatusCode,
    formatNoAccount: () => ({ error: { message: "No account", type: "server_error" } }),
    format429: (message: string) => ({ error: { message, type: "rate_limit_error" } }),
    formatError: (status: number, message: string) => ({ error: { status, message } }),
    streamTranslator: async function* () {
      yield "data: {}\n\n";
    },
    collectTranslator: async () => ({
      response: { ok: true },
      usage: { input_tokens: 1, output_tokens: 1 },
      responseId: "resp-test",
    }),
  };
}

function makeProxyRequest(model = "gpt-5.2-codex"): ProxyRequest {
  return {
    codexRequest: { model } as ProxyRequest["codexRequest"],
    model,
    isStreaming: false,
  };
}

describe("shared proxy handler proxy resolution", () => {
  let accountPool: AccountPool;
  let proxyPool: ProxyPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    accountPool = new AccountPool();
    proxyPool = new ProxyPool();
    mockCreateResponse.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(c, accountPool, undefined, makeProxyRequest(), createTestFormat(), proxyPool),
    );
  });

  afterEach(() => {
    accountPool.destroy();
    proxyPool.destroy();
  });

  it("forwards a directly assigned active proxy URL", async () => {
    const entryId = accountPool.addAccount("token-handler-explicit");
    const proxyId = proxyPool.add("proxy-handler-explicit", "http://127.0.0.1:8801");
    proxyPool.assign(entryId, proxyId);

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      entryId,
      "http://127.0.0.1:8801",
    );
  });

  it("falls back to global semantics when the configured proxy is disabled", async () => {
    const entryId = accountPool.addAccount("token-handler-disabled");
    const proxyId = proxyPool.add("proxy-handler-disabled", "http://127.0.0.1:8802");
    proxyPool.assign(entryId, proxyId);
    proxyPool.disable(proxyId);

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      entryId,
      undefined,
    );
  });

  it("preserves direct semantics by forwarding null", async () => {
    const entryId = accountPool.addAccount("token-handler-direct");
    proxyPool.assign(entryId, "direct");

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      entryId,
      null,
    );
  });

  it("resolves auto semantics to an active proxy URL", async () => {
    const entryId = accountPool.addAccount("token-handler-auto");
    proxyPool.add("proxy-handler-auto", "http://127.0.0.1:8803");
    proxyPool.assign(entryId, "auto");

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(codexApiCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      entryId,
      "http://127.0.0.1:8803",
    );
  });
});
