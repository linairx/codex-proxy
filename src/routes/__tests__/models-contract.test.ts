/**
 * Route contract tests for model endpoints.
 *
 * Covers:
 * - /v1/models list shape with catalog models and aliases
 * - /v1/models/catalog full catalog response
 * - /v1/models/:modelId success, alias hit, and stable 404 contract
 * - /v1/models/:modelId/info alias resolution and 404 contract
 * - Route priority for /catalog and /:id/info
 * - POST /admin/refresh-models compatibility coverage
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: { default: "gpt-5.2-codex" },
  api: { base_url: "https://chatgpt.com/backend-api" },
  client: { app_version: "1.0.0" },
};

const staticCatalog = [
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
  },
];

const staticAliases = {
  "gpt-5": "gpt-5.4",
  codex: "gpt-5.2-codex",
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("../../paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-model-contract-config"),
  getDataDir: vi.fn(() => "/tmp/test-model-contract-data"),
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
    load: vi.fn(() => ({ models: staticCatalog, aliases: staticAliases })),
    dump: vi.fn(() => ""),
  },
}));

vi.mock("../../models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

import { createModelRoutes } from "../models.js";
import { loadStaticModels } from "../../models/model-store.js";
import { triggerImmediateRefresh } from "../../models/model-fetcher.js";

describe("model route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    loadStaticModels();
  });

  it("GET /v1/models returns OpenAI list structure with catalog models and aliases", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models");

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(4);

    const ids = body.data.map((entry: { id: string }) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining(["gpt-5.2-codex", "gpt-5.4", "gpt-5", "codex"]),
    );

    for (const entry of body.data) {
      expect(entry.object).toBe("model");
      expect(entry.created).toBe(1700000000);
      expect(entry.owned_by).toBe("openai");
    }
  });

  it("GET /v1/models/catalog returns full catalog structure", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/catalog");

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      id: "gpt-5.2-codex",
      displayName: "GPT-5.2 Codex",
      description: "Default coding model",
      isDefault: true,
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
      supportsPersonality: false,
      upgrade: null,
      source: "static",
    });
    expect(body[0].supportedReasoningEfforts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasoningEffort: "medium" }),
        expect.objectContaining({ reasoningEffort: "high" }),
      ]),
    );
    expect(body[1]).toMatchObject({
      id: "gpt-5.4",
      source: "static",
    });
  });

  it("GET /v1/models/:modelId returns canonical model entry for known model", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/gpt-5.4");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "gpt-5.4",
      object: "model",
      created: 1700000000,
      owned_by: "openai",
    });
  });

  it("GET /v1/models/:modelId returns alias entry when alias is requested", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/gpt-5");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "gpt-5",
      object: "model",
      created: 1700000000,
      owned_by: "openai",
    });
  });

  it("GET /v1/models/:modelId returns stable 404 contract for unknown model", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/unknown-model");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: "Model 'unknown-model' not found",
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
  });

  it("GET /v1/models/:modelId/info resolves alias before returning canonical info", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/gpt-5/info");

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "General model",
      defaultReasoningEffort: "low",
      source: "static",
    });
    expect(body.supportedReasoningEfforts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasoningEffort: "low" }),
        expect.objectContaining({ reasoningEffort: "medium" }),
      ]),
    );
  });

  it("GET /v1/models/:modelId/info returns stable 404 contract for unknown model", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/not-exist/info");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Model 'not-exist' not found",
    });
  });

  it("/v1/models/catalog is not swallowed by /:modelId route", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/catalog");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("displayName");
    expect(body[0]).not.toHaveProperty("object", "model");
  });

  it("/v1/models/:id/info is not swallowed by generic detail route", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/codex/info");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty("id", "gpt-5.2-codex");
    expect(body).toHaveProperty("displayName", "GPT-5.2 Codex");
    expect(body).not.toHaveProperty("object", "model");
  });
});

describe("POST /admin/refresh-models compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    loadStaticModels();
  });

  it("returns compatibility success response and triggers refresh", async () => {
    const app = createModelRoutes();
    const res = await app.request("/admin/refresh-models", { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: "Model refresh triggered",
    });
    expect(triggerImmediateRefresh).toHaveBeenCalledOnce();
  });

  it("keeps existing auth compatibility behavior when proxy_api_key is configured", async () => {
    mockConfig.server.proxy_api_key = "test-secret";
    const app = createModelRoutes();

    const unauthorized = await app.request("/admin/refresh-models", {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized" });

    const authorized = await app.request("/admin/refresh-models", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(authorized.status).toBe(200);
    expect(triggerImmediateRefresh).toHaveBeenCalledOnce();
  });
});
