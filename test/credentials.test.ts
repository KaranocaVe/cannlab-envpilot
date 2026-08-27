import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCredentialResponse } from "../src/credentials.js";

test("sensitive credential output is JSON, private, and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envpilot-credential-"));
  const path = join(directory, "credential.json");
  await writeCredentialResponse(path, { data: { private_key: "secret-value" } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(() => writeCredentialResponse(path, { data: { private_key: "other" } }), /overwrite/);
});
