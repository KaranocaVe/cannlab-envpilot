import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDotEnvFile, resolveSettings } from "../src/config.js";

test("dotenv accepts hyphenated GitCode keys and tightens file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envpilot-config-"));
  const path = join(directory, ".env");
  await writeFile(path, "gitcode-account=alice\ngitcode-password=secret\n", "utf8");
  await chmod(path, 0o644);
  const loaded = loadDotEnvFile(path);
  assert.equal(loaded.values["gitcode-account"], "alice");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const settings = resolveSettings({ envFile: path, apiBase: "https://example.test/api" });
  assert.equal(settings.gitcodeAccount, "alice");
  assert.equal(settings.gitcodePassword, "secret");
});
