import test from "node:test";
import assert from "node:assert/strict";

import { GitCodeAuthClient } from "../src/auth-client.js";
import { resolveSettings } from "../src/config.js";
import { encryptGitCodePassword } from "../src/crypto.js";
import { jsonResponse } from "./helpers.js";

test("password login sends the frontend AES form fields", async () => {
  let body = "";
  let headers: HeadersInit | undefined;
  const settings = resolveSettings({ apiBase: "https://example.test" });
  const client = new GitCodeAuthClient(settings, {
    fetchImpl: async (_input, init) => {
      body = String(init?.body);
      headers = init?.headers;
      return jsonResponse({ data: { access_token: "access", refresh_token: "refresh", username: "alice" } });
    },
  });
  const result = await client.loginWithPassword("alice", "Passw0rd!");
  const form = new URLSearchParams(body);
  assert.equal(form.get("username"), "alice");
  assert.equal(form.get("password"), encryptGitCodePassword("Passw0rd!"));
  assert.equal(form.get("captcha_id"), "");
  assert.equal((headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  assert.equal(result.accessToken, "access");
  assert.equal(result.refreshToken, "refresh");
});

test("password login accepts HTTP-style success codes in the response envelope", async () => {
  const settings = resolveSettings({ apiBase: "https://example.test" });
  const client = new GitCodeAuthClient(settings, {
    fetchImpl: async () => jsonResponse({ code: 200, data: { access_token: "access-200" } }),
  });
  assert.equal((await client.loginWithPassword("alice", "Passw0rd!")).accessToken, "access-200");
});

test("nested authentication errors are recognized as challenge responses", async () => {
  const settings = resolveSettings({ apiBase: "https://example.test" });
  const client = new GitCodeAuthClient(settings, {
    fetchImpl: async () => jsonResponse({ code: 0, data: { error: { error_code: "CAPTCHA_REQUIRED", error_message: "验证码 required" } } }),
  });
  await assert.rejects(() => client.loginWithPassword("alice", "Passw0rd!"), /验证码/);
});
