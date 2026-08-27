import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAuthCache, saveAuthCache } from "../src/auth-store.js";
import { redact } from "../src/errors.js";

test("auth cache is private and never stores xauth_token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envpilot-auth-"));
  const path = join(directory, "nested", "auth.json");
  await saveAuthCache(path, { access_token: "web-access", refresh_token: "web-refresh", account: "alice" });
  const loaded = await loadAuthCache(path);
  assert.equal(loaded?.access_token, "web-access");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const text = await readFile(path, "utf8");
  assert.equal(text.includes("xauth"), false);
  assert.equal(text.includes("web-access"), true);
});

test("redaction removes bearer and labeled secrets from diagnostic text", () => {
  assert.equal(redact("Authorization: Bearer abc123 access_token=xyz password='pw'") as string, "Authorization: Bearer [REDACTED] access_token=[REDACTED] password=[REDACTED]");
});
