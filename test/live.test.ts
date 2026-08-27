import test from "node:test";
import assert from "node:assert/strict";

import { parseCatalog, resolveGoodsSpec, resolveCreatePayload } from "../src/catalog.js";
import { EnvironmentService } from "../src/environment.js";
import { normalizeResource } from "../src/resources.js";
import { createRuntime } from "../src/runtime.js";

const mutationsAllowed = process.env.CANNLAB_ALLOW_LIVE_MUTATIONS === "1";
const liveEnabled = process.env.CANNLAB_RUN_LIVE === "1";

test("live read-only CANNLab endpoints", { skip: !liveEnabled ? "Set CANNLAB_RUN_LIVE=1 to run network verification." : false }, async () => {
  const runtime = createRuntime({ wait: true });
  await runtime.auth.resolve();
  await runtime.api.getOverview();
  await runtime.api.getCreateAccess();
  await runtime.api.getCreateGoods();
  const service = new EnvironmentService({ api: runtime.api, poll: { wait: true, intervalMs: 0, timeoutMs: 30_000 } });
  const catalog = await service.catalog();
  assert.ok(catalog.templates.length >= 0);
  await service.list();
});

test("live CPU lifecycle is opt-in and cleans up in finally", { skip: !mutationsAllowed ? "Set CANNLAB_ALLOW_LIVE_MUTATIONS=1 to authorize remote lifecycle mutations." : false }, async () => {
  const runtime = createRuntime({ wait: true, interval: process.env.CANNLAB_LIVE_INTERVAL ?? "5s", timeout: process.env.CANNLAB_LIVE_TIMEOUT ?? "30m" });
  await runtime.auth.resolve();
  const service = new EnvironmentService({
    api: runtime.api,
    poll: { wait: true, intervalMs: runtime.settings.pollIntervalMs, timeoutMs: runtime.settings.timeoutMs },
    progress: (message) => process.stderr.write(`[live] ${message}\n`),
  });
  let instanceKey: string | undefined;
  let created = false;
  const name = `cp${Date.now().toString(36).slice(-10)}`.slice(0, 15);
  try {
    const access = await runtime.api.getCreateAccess();
    const goods = await runtime.api.getCreateGoods();
    const preliminary = parseCatalog(access, goods, undefined, "cpu");
    const machine = resolveGoodsSpec(preliminary, "cpu", "CPU");
    const config = await runtime.api.getCreateConfig(machine.goodsCode, machine.specCode);
    const catalog = parseCatalog(access, goods, config, "cpu");
    const template = catalog.templates[0];
    assert.ok(template?.name, "CANNLab did not return a CPU template");
    const templateSpec = catalog.templateSpecs
      .filter((option) => !option.templateCode || option.templateCode === template.templateCode)
      .sort((left, right) => cpuAmount(left.raw) - cpuAmount(right.raw))[0];
    assert.ok(templateSpec?.name, "CANNLab did not return a CPU template flavor");
    const createdResult = await service.create({ type: "cpu", name, template: template.name, spec: templateSpec.name });
    instanceKey = createdResult.resource?.instanceKey;
    created = Boolean(instanceKey);
    assert.ok(instanceKey, "CANNLab create response did not include an instance key");
    const current = normalizeResource(await runtime.api.getResource(instanceKey));
    if (current?.status !== "stopped") await service.stop(instanceKey);
    await service.start(instanceKey);
    await service.stop(instanceKey);
    await service.start(instanceKey);
  } finally {
    if (!instanceKey) {
      try { instanceKey = (await service.list()).resources.find((resource) => resource.name === name)?.instanceKey; } catch { /* best effort discovery */ }
    }
    if (instanceKey) {
      try { await service.stop(instanceKey); } catch { /* best effort cleanup */ }
      try { await service.delete(instanceKey, "instance"); } catch { /* best effort cleanup */ }
    }
    if (created && instanceKey) {
      const remaining = (await service.list()).resources.some((resource) => resource.instanceKey === instanceKey);
      assert.equal(remaining, false, `temporary environment ${instanceKey} still appears in the final list`);
    }
  }
});

function cpuAmount(value: unknown): number {
  if (!value || typeof value !== "object") return Number.MAX_SAFE_INTEGER;
  const resource = (value as Record<string, unknown>).resource_config;
  if (!resource || typeof resource !== "object") return Number.MAX_SAFE_INTEGER;
  const cpu = (resource as Record<string, unknown>).cpu;
  return typeof cpu === "number" ? cpu : Number.MAX_SAFE_INTEGER;
}
