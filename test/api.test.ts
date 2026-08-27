import test from "node:test";
import assert from "node:assert/strict";

import { CannlabApiClient } from "../src/api.js";
import { ApiError, AuthError } from "../src/errors.js";
import { jsonResponse } from "./helpers.js";

test("API uses the CANNLab URL, JSON body, and Bearer web token", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return jsonResponse({ code: 0, data: { ok: true } });
  };
  const api = new CannlabApiClient("https://example.test/score-proxy/api/v1/shop/third-party", {
    fetchImpl,
    auth: { resolve: async () => ({ accessToken: "web-token" }), refresh: async () => undefined },
  });
  await api.createEnvironment({
    goods_code: "g",
    spec_code: "s",
    instance_name: "demo",
    template_code: "t",
    template_spec_code: "ts",
    image_code: "i",
  });
  assert.equal(seenUrl, "https://example.test/score-proxy/api/v1/shop/third-party/resources");
  assert.equal((seenInit?.headers as Record<string, string>).Authorization, "Bearer web-token");
  assert.deepEqual(JSON.parse(String(seenInit?.body)), {
    goods_code: "g",
    spec_code: "s",
    instance_name: "demo",
    template_code: "t",
    template_spec_code: "ts",
    image_code: "i",
  });
});

test("GET token failure can refresh once, while mutation failures are not replayed", async () => {
  let calls = 0;
  let current = "old";
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error_code_name: "TOKEN_INVALID_ERROR", error_message: "invalid" }, 401);
    return jsonResponse({ code: 0, data: { ok: true } });
  };
  const api = new CannlabApiClient("https://example.test", {
    fetchImpl,
    auth: {
      resolve: async () => ({ accessToken: current }),
      refresh: async () => { current = "new"; return current; },
    },
    retryBaseMs: 0,
  });
  await api.getOverview();
  assert.equal(calls, 2);
});

test("mutation token failures are neither refreshed nor replayed", async () => {
  let calls = 0;
  let refreshes = 0;
  const api = new CannlabApiClient("https://example.test", {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error_code_name: "TOKEN_INVALID_ERROR", error_message: "invalid token" }, 401);
    },
    auth: {
      resolve: async () => ({ accessToken: "old" }),
      refresh: async () => { refreshes += 1; return "new"; },
    },
    retryBaseMs: 0,
  });
  await assert.rejects(() => api.createEnvironment({
    goods_code: "g",
    spec_code: "s",
    instance_name: "demo",
    template_code: "t",
    template_spec_code: "ts",
    image_code: "i",
  }), ApiError);
  assert.equal(calls, 1);
  assert.equal(refreshes, 0);
});

test("nested API error envelopes preserve code, message, and trace", async () => {
  const api = new CannlabApiClient("https://example.test", {
    fetchImpl: async () => jsonResponse({ data: { error: { code: "E_NOT_READY", message: "not ready", trace_id: "trace-1" } } }, 409),
    auth: { resolve: async () => ({ accessToken: "web-token" }), refresh: async () => undefined },
  });
  await assert.rejects(
    () => api.getOverview(),
    (error: unknown) => error instanceof ApiError && error.api.status === 409 && error.api.errorCode === "E_NOT_READY" && error.api.errorMessage === "not ready" && error.api.traceId === "trace-1",
  );
});

test("HTTP-style success codes are not treated as API failures", async () => {
  const api = new CannlabApiClient("https://example.test", {
    fetchImpl: async () => jsonResponse({ code: 200, data: { ok: true } }),
    auth: { resolve: async () => ({ accessToken: "web-token" }), refresh: async () => undefined },
  });
  assert.deepEqual(await api.getOverview(), { code: 200, data: { ok: true } });
});

test("null error fields in a successful envelope are ignored", async () => {
  const api = new CannlabApiClient("https://example.test", {
    fetchImpl: async () => jsonResponse({ code: 0, error: null, errors: [], data: { ok: true } }),
    auth: { resolve: async () => ({ accessToken: "web-token" }), refresh: async () => undefined },
  });
  assert.deepEqual(await api.getOverview(), { code: 0, error: null, errors: [], data: { ok: true } });
});

test("authentication errors are not mislabeled as ambiguous API mutations", async () => {
  const api = new CannlabApiClient("https://example.test", {
    fetchImpl: fetch,
    auth: { resolve: async () => { throw new AuthError("missing credentials"); }, refresh: async () => undefined },
  });
  await assert.rejects(() => api.createEnvironment({
    goods_code: "g",
    spec_code: "s",
    instance_name: "demo",
    template_code: "t",
    template_spec_code: "ts",
    image_code: "i",
  }), (error: unknown) => error instanceof AuthError && !(error instanceof ApiError));
});
