import test from "node:test";
import assert from "node:assert/strict";

import { waitForProvisioned, waitForResource, waitForUpgrade } from "../src/poll.js";
import { jsonResponse } from "./helpers.js";

test("resource polling follows status aliases until running", async () => {
  const states = ["creating", "opening", "running"];
  let index = 0;
  const result = await waitForResource(async () => ({ data: { instance_key: "i-1", status: states[Math.min(index++, states.length - 1)] } }), "running", {
    wait: true,
    intervalMs: 0,
    timeoutMs: 1000,
  });
  assert.equal((result as { data: { status: string } }).data.status, "running");
  assert.equal(index, 3);
});

test("provisioning does not finish while the resource is still opening", async () => {
  const states = ["OPENING", "PROCESSING"];
  let index = 0;
  const result = await waitForProvisioned(async () => ({ data: { instance_key: "i-1", status: states[Math.min(index++, states.length - 1)] } }), {
    wait: true,
    intervalMs: 0,
    timeoutMs: 1000,
  });
  assert.equal((result as { data: { status: string } }).data.status, "PROCESSING");
  assert.equal(index, 2);
});

test("upgrade polling does not treat PROCESSING as a completed upgrade", async () => {
  const states = ["PROCESSING", "SUCCESS"];
  let index = 0;
  const result = await waitForUpgrade(async () => ({ status: states[Math.min(index++, states.length - 1)] }), {
    wait: true,
    intervalMs: 0,
    timeoutMs: 1000,
  });
  assert.equal((result as { status: string }).status, "SUCCESS");
  assert.equal(index, 2);
});
