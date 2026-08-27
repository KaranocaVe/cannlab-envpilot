import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthManager } from "../src/auth-manager.js";
import { resolveSettings } from "../src/config.js";
import { saveAuthCache } from "../src/auth-store.js";
import { jsonResponse } from "./helpers.js";

test("authentication resolution prefers explicit token, then cache, then dotenv token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envpilot-manager-"));
  const envFile = join(directory, ".env");
  const authFile = join(directory, "auth.json");
  await writeFile(envFile, "CANNLAB_ACCESS_TOKEN=dotenv-token\n", "utf8");
  await saveAuthCache(authFile, { access_token: "cached-token" });

  const explicit = new AuthManager(resolveSettings({ envFile, authFile, accessToken: "explicit-token", apiBase: "https://example.test" }), { validateToken: async () => undefined });
  assert.equal((await explicit.resolve()).accessToken, "explicit-token");

  const cached = new AuthManager(resolveSettings({ envFile, authFile, apiBase: "https://example.test" }), { validateToken: async () => undefined });
  assert.equal((await cached.resolve()).accessToken, "cached-token");

  const { rm } = await import("node:fs/promises");
  await rm(authFile);
  const dotenv = new AuthManager(resolveSettings({ envFile, authFile, apiBase: "https://example.test" }), { validateToken: async () => undefined });
  const token = await dotenv.resolve();
  assert.equal(token.accessToken, "dotenv-token");
  assert.equal(token.source, "dotenv");
});

test("captcha fallback accepts a pasted web token and caches only the safe token fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envpilot-login-"));
  const authFile = join(directory, "auth.json");
  const settings = resolveSettings({
    authFile,
    envFile: join(directory, "missing.env"),
    apiBase: "https://example.test",
  });
  settings.gitcodeAccount = "alice";
  settings.gitcodePassword = "password";

  const manager = new AuthManager(settings, {
    fetchImpl: async (input) => {
      if (String(input).includes("/oauth/login")) return jsonResponse({ error_message: "易盾验证码 required" }, 418);
      return jsonResponse({ code: 0, data: { ok: true } });
    },
    prompt: async () => "pasted-web-token",
    validateToken: async (token) => assert.equal(token, "pasted-web-token"),
  });
  const token = await manager.login();
  assert.equal(token.source, "prompt");
  assert.equal(JSON.parse(await readFile(authFile, "utf8")).access_token, "pasted-web-token");
  assert.equal(JSON.stringify(JSON.parse(await readFile(authFile, "utf8"))).includes("password"), false);
  assert.equal((await stat(authFile)).mode & 0o777, 0o600);
});

test("refresh updates the cache and sends the old bearer plus refresh token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envpilot-refresh-"));
  const authFile = join(directory, "auth.json");
  await saveAuthCache(authFile, { access_token: "old-access", refresh_token: "old-refresh", account: "alice" });
  let seenUrl = "";
  let seenHeaders: Record<string, string> | undefined;
  let seenBody = "";
  const settings = resolveSettings({ authFile, envFile: join(directory, "missing.env"), apiBase: "https://example.test" });
  settings.gitcodeAuthBase = "https://example.test";
  const manager = new AuthManager(settings, {
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenHeaders = init?.headers as Record<string, string>;
      seenBody = String(init?.body);
      return jsonResponse({ data: { access_token: "new-access" } });
    },
  });
  assert.equal(await manager.refresh(), "new-access");
  assert.equal(seenUrl, "https://example.test/uc/api/v1/user/token/refresh");
  assert.equal(seenHeaders?.Authorization, "Bearer old-access");
  assert.equal(new URLSearchParams(seenBody).get("refresh_token"), "old-refresh");
  assert.equal(JSON.parse(await readFile(authFile, "utf8")).access_token, "new-access");
});

test("token login rejects an error envelope even when HTTP status is 200", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envpilot-validate-"));
  const settings = resolveSettings({
    accessToken: "candidate-token",
    authFile: join(directory, "auth.json"),
    envFile: join(directory, "missing.env"),
    apiBase: "https://example.test",
  });
  const manager = new AuthManager(settings, {
    fetchImpl: async () => jsonResponse({ code: 401, error_message: "token expired" }, 200),
  });
  await assert.rejects(() => manager.login(), /validation failed/);
});
