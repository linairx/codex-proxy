/**
 * Tests that /v1/responses works without the `instructions` field.
 * Regression test for: https://github.com/icebear0828/codex-proxy/issues/71
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// ── Mocks (before imports) ──────────────────────────────────────────

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: {
    default: "gpt-5.2-codex",
    default_reasoning_effort: null,
    default_service_tier: null,
    suppress_desktop_directives: false,
  },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-responses"),
  getConfigDir: vi.fn(() => "/tmp/test-responses-config"),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "models: []"),
  writeFileSync: vi.fn(),
  writeFile: vi.fn(
    (_p: string, _d: string, _e: string, cb: (err: Error | null) => void) =>
      cb(null),
  ),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => ""),
  },
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

vi.mock("../../utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Capture the codexRequest sent through the real proxy handler
let capturedCodexRequest: unknown = null;

vi.mock("../../proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation(() => ({
    createResponse: vi.fn(async (request: unknown) => {
      capturedCodexRequest = request;
      return new Response(
        [
          'event: response.completed',
          'data: {"response":{"id":"resp-test","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}',
          '',
        ].join("\n"),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }),
    parseStream: vi.fn(async function* (response: Response) {
      const text = await response.text();
      for (const chunk of text.split("\n\n")) {
        if (!chunk.trim()) continue;
        const lines = chunk.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
        const dataLine = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
        yield { event, data: JSON.parse(dataLine) };
      }
    }),
  })),
  CodexApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      super(body);
      this.name = "CodexApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

// ── Imports ─────────────────────────────────────────────────────────

import { AccountPool } from "../../auth/account-pool.js";
import { loadStaticModels } from "../../models/model-store.js";
import { createResponsesRoutes } from "../responses.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("/v1/responses — optional instructions", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCodexRequest = null;
    mockConfig.server.proxy_api_key = null;
    loadStaticModels();
    pool = new AccountPool();
    pool.addAccount("test-token-1");
    app = createResponsesRoutes(pool);
  });

  afterEach(() => {
    pool?.destroy();
  });

  it("accepts request without instructions field", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
  });

  it("accepts request with instructions: null", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        instructions: null,
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
  });

  it("defaults instructions to empty string when omitted", async () => {
    await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(capturedCodexRequest).toBeDefined();
    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.instructions).toBe("");
  });

  it("preserves instructions when provided as string", async () => {
    await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        instructions: "You are a helpful assistant.",
        input: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(capturedCodexRequest).toBeDefined();
    const req = capturedCodexRequest as Record<string, unknown>;
    expect(req.instructions).toBe("You are a helpful assistant.");
  });

  it("still rejects non-object body", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not an object"),
    });

    expect(res.status).toBe(400);
  });
});
