import test from "node:test";
import assert from "node:assert/strict";

import goods from "./fixtures/create-goods.json" with { type: "json" };
import config from "./fixtures/create-config.json" with { type: "json" };
import { parseCatalog, resolveCreatePayload } from "../src/catalog.js";

test("catalog parser resolves dynamic names into the exact create fields", () => {
  const catalog = parseCatalog({}, goods, config, "cpu");
  const payload = resolveCreatePayload(catalog, { type: "cpu", name: "tmp-env", spec: "2 vCPU / 8 GiB", template: "CANN base" });
  assert.deepEqual(payload, {
    goods_code: "goods-cpu",
    spec_code: "spec-cpu-small",
    instance_name: "tmp-env",
    template_code: "template-cpu",
    template_spec_code: "template-spec-cpu",
    image_code: "image-cpu-1",
    template_name: "CANN base",
    template_spec_name: "Ubuntu",
    image_name: "CANN image",
    cann_version: "8.2.RC1",
  });
});

test("nested template specs remain linked to their parent template", () => {
  const catalog = parseCatalog({}, goods, {
    data: {
      env_types: [{
        resource_type: "cpu",
        templates: [{
          template_code: "template-one",
          template_name: "Template one",
          image_code: "image-one",
          specs: [
            { template_spec_code: "flavor-small", template_spec_name: "Small" },
            { template_spec_code: "flavor-large", template_spec_name: "Large" },
          ],
        }],
      }],
    },
  }, "cpu");
  const payload = resolveCreatePayload(catalog, { type: "cpu", name: "tmp-env", spec: "Large", template: "Template one" });
  assert.equal(payload.template_spec_code, "flavor-large");
});

test("catalog options are deduplicated by code and type while retaining names", () => {
  const catalog = parseCatalog({}, {
    data: [
      { goods_code: "goods-cpu", attributes: { resourceType: "cpu" } },
      { goods_code: "goods-cpu", goods_name: "CPU", attributes: { resourceType: "cpu" } },
    ],
  }, undefined, "cpu");
  assert.equal(catalog.goods.length, 1);
  assert.equal(catalog.goods[0]?.name, "CPU");
});
