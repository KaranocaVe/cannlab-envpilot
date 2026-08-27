import test from "node:test";
import assert from "node:assert/strict";

import { confirmDestructive } from "../src/confirm.js";

test("destructive actions require --yes in a non-interactive process", async () => {
  await assert.rejects(() => confirmDestructive("delete", false), /--yes/);
  await confirmDestructive("delete", true);
});
