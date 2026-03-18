/**
 * Integration tests for plan-based model routing through the proxy layer.
 *
 * Verifies that:
 * 1. Account pool correctly filters by model plan types when proxy handler acquires an account
 * 2. Plan map updates unblock previously rejected requests
 * 3. POST /admin/refresh-models triggers immediate model refresh
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// ── Mocks (before imports) ──────────────────────────────────────────

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: { default: "gpt-5.2-codex" },
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
  getDataDir: vi.fn(() => "/tmp/test-plan-routing"),
  getConfigDir: vi.fn(() => "/tmp/test-plan-routing-config"),
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

const mockCreateResponse = vi.fn();
const mockCatalog: Array<{
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  upgrade: string | null;
  source: "static" | "backend";
}> = [];
const mockAliases: Record<string, string> = {};
const mockPlanModelMap = new Map<string, Set<string>>();

function resetMockModelStore() {
  mockCatalog.length = 0;
  mockCatalog.push(
    {
      id: "gpt-5.2-codex",
      displayName: "GPT-5.2 Codex",
      description: "Default coding model",
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deeper" },
      ],
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
      supportsPersonality: false,
      upgrade: null,
      source: "static",
    },
    {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "General model",
      isDefault: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" },
      ],
      defaultReasoningEffort: "low",
      inputModalities: ["text", "image"],
      supportsPersonality: true,
      upgrade: "gpt-5.4-pro",
      source: "static",
    },
  );

  for (const key of Object.keys(mockAliases)) {
    delete mockAliases[key];
  }
  mockAliases["gpt-5"] = "gpt-5.4";
  mockAliases.codex = "gpt-5.2-codex";
  mockPlanModelMap.clear();
}

vi.mock("../../models/model-store.js", () => ({
  loadStaticModels: vi.fn(() => {
    resetMockModelStore();
  }),
  applyBackendModelsForPlan: vi.fn((planType: string, backendModels: Array<{ slug?: string; id?: string; name?: string }>) => {
    const ids = new Set<string>();
    for (const raw of backendModels) {
      const id = raw.slug ?? raw.id ?? raw.name ?? "";
      if (!id) continue;
      ids.add(id);
      if (!mockCatalog.some((model) => model.id === id)) {
        mockCatalog.push({
          id,
          displayName: id,
          description: "",
          isDefault: false,
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          upgrade: null,
          source: "backend",
        });
      }
    }
    mockPlanModelMap.set(planType, ids);
  }),
  getModelPlanTypes: vi.fn((modelId: string) => {
    const plans: string[] = [];
    for (const [planType, ids] of mockPlanModelMap) {
      if (ids.has(modelId)) plans.push(planType);
    }
    return plans;
  }),
  getModelCatalog: vi.fn(() => mockCatalog.map((model) => ({ ...model }))),
  getModelAliases: vi.fn(() => ({ ...mockAliases })),
  getModelInfo: vi.fn((modelId: string) => {
    const resolved = mockAliases[modelId] ?? modelId;
    const model = mockCatalog.find((entry) => entry.id === resolved);
    return model ? { ...model } : undefined;
  }),
  getModelStoreDebug: vi.fn(() => ({
    catalogSize: mockCatalog.length,
    aliasCount: Object.keys(mockAliases).length,
    planMap: Object.fromEntries(
      [...mockPlanModelMap.entries()].map(([planType, ids]) => [planType, [...ids]]),
    ),
  })),
}));

vi.mock("../../proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation(() => ({
    createResponse: mockCreateResponse,
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

vi.mock("../../utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// ── Imports ─────────────────────────────────────────────────────────

import { AccountPool } from "../../auth/account-pool.js";
import {
  loadStaticModels,
  applyBackendModelsForPlan,
} from "../../models/model-store.js";
import {
  handleProxyRequest,
  type FormatAdapter,
  type ProxyRequest,
} from "../shared/proxy-handler.js";
import type { StatusCode } from "hono/utils/http-status";
import { createModelRoutes } from "../models.js";
import { triggerImmediateRefresh } from "../../models/model-fetcher.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeModel(slug: string) {
  return { slug, id: slug, name: slug };
}

function createTestFormat(): FormatAdapter {
  return {
    tag: "Test",
    noAccountStatus: 503 as StatusCode,
    formatNoAccount: () => ({
      error: {
        message: "No account available for this model",
        type: "server_error",
      },
    }),
    format429: (msg: string) => ({
      error: { message: msg, type: "rate_limit_error" },
    }),
    formatError: (status: number, msg: string) => ({
      error: { status, message: msg },
    }),
    streamTranslator: async function* () {
      yield "data: {}\n\n";
    },
    collectTranslator: async () => ({
      response: { id: "resp-test", object: "chat.completion", choices: [] },
      usage: { input_tokens: 10, output_tokens: 20 },
      responseId: "resp-test",
    }),
  };
}

function makeProxyRequest(model: string): ProxyRequest {
  return {
    codexRequest: { model } as ProxyRequest["codexRequest"],
    model,
    isStreaming: false,
  };
}

function addAccountWithPlan(pool: AccountPool, token: string, planType: "free" | "team") {
  const entryId = pool.addAccount(token);
  const entry = pool.getEntry(entryId);
  if (!entry) {
    throw new Error(`Failed to create test account for ${token}`);
  }
  entry.planType = planType;
  return entryId;
}

function addFreeAccount(pool: AccountPool, token = "free-token-1") {
  return addAccountWithPlan(pool, token, "free");
}

function addTeamAccount(pool: AccountPool, token = "team-token-1") {
  return addAccountWithPlan(pool, token, "team");
}

// ── Tests ───────────────────────────────────────────────────────────

describe("plan routing through proxy handler", () => {
  let pool: AccountPool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.auth.jwt_token = undefined;
    mockConfig.server.proxy_api_key = null;
    delete process.env.CODEX_JWT_TOKEN;

    loadStaticModels();

    pool = new AccountPool();
    mockCreateResponse.mockResolvedValue(
      new Response(JSON.stringify({ ok: true })),
    );
  });

  afterEach(() => {
    pool?.destroy();
  });

  it("free-only pool + team-only model → 503", async () => {
    addFreeAccount(pool);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toContain("No account");
  });

  it("free-only pool + model in both plans → 200", async () => {
    addFreeAccount(pool);
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("plan map update → previously blocked request now succeeds", async () => {
    addFreeAccount(pool);
    applyBackendModelsForPlan("team", [makeModel("gpt-5.4")]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    // Blocked — free can't use team-only model
    const res1 = await app.request("/test", { method: "POST" });
    expect(res1.status).toBe(503);

    // Backend refresh: free now has gpt-5.4
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
    ]);

    // Same request now succeeds
    const res2 = await app.request("/test", { method: "POST" });
    expect(res2.status).toBe(200);
  });

  it("team-only pool + team model → 200", async () => {
    addTeamAccount(pool);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("mixed pool prefers plan-matched account", async () => {
    addFreeAccount(pool);
    addTeamAccount(pool);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);

    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(
        c,
        pool,
        undefined,
        makeProxyRequest("gpt-5.4"),
        createTestFormat(),
      ),
    );

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    // Team account is used (only plan supporting gpt-5.4)
    expect(mockCreateResponse).toHaveBeenCalledOnce();
  });
});

describe("POST /admin/refresh-models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    loadStaticModels();
  });

  it("triggers model refresh and returns 200", async () => {
    const app = createModelRoutes();
    const res = await app.request("/admin/refresh-models", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("Model refresh triggered");
    expect(triggerImmediateRefresh).toHaveBeenCalledOnce();
  });

  it("requires auth when proxy_api_key is set", async () => {
    mockConfig.server.proxy_api_key = "test-secret";
    const app = createModelRoutes();

    // No auth → 401
    const res1 = await app.request("/admin/refresh-models", {
      method: "POST",
    });
    expect(res1.status).toBe(401);
    expect(triggerImmediateRefresh).not.toHaveBeenCalled();

    // Wrong auth → 401
    const res2 = await app.request("/admin/refresh-models", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res2.status).toBe(401);

    // Correct auth → 200
    const res3 = await app.request("/admin/refresh-models", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res3.status).toBe(200);
    expect(triggerImmediateRefresh).toHaveBeenCalledOnce();
  });
});
