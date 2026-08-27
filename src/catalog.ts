import { CliError } from "./errors.js";
import { firstString, isRecord, normalizeType, unwrapData } from "./utils.js";
import type { CatalogOption, CatalogSnapshot, CreateEnvironmentPayload } from "./types.js";

export interface CreateSelectionArgs {
  type: string;
  template: string;
  spec: string;
  image?: string;
  name: string;
  repo?: Partial<Pick<CreateEnvironmentPayload, "repo_path" | "repo_url" | "repo_name" | "repo_lang" | "repo_branch">>;
}

export function parseCatalog(access: unknown, goods: unknown, config?: unknown, type?: string): CatalogSnapshot {
  const wantedType = normalizeType(type);
  const result: CatalogSnapshot = {
    goods: [],
    specs: [],
    templates: [],
    templateSpecs: [],
    images: [],
    raw: { access, goods, config },
  };
  collectCatalogOptions(access, result, wantedType);
  collectCatalogOptions(goods, result, wantedType);
  if (config !== undefined) collectCatalogOptions(config, result, wantedType);
  result.goods = dedupe(result.goods);
  result.specs = dedupe(result.specs);
  result.templates = dedupe(result.templates);
  result.templateSpecs = dedupe(result.templateSpecs);
  result.images = dedupe(result.images);
  return result;
}

export function parseGoodsCatalog(value: unknown, type?: string): { goods: CatalogOption[]; specs: CatalogOption[] } {
  const snapshot = parseCatalog(undefined, value, undefined, type);
  return { goods: snapshot.goods, specs: snapshot.specs };
}

export function parseConfigCatalog(value: unknown, type?: string): Pick<CatalogSnapshot, "templates" | "templateSpecs" | "images" | "specs"> {
  const snapshot = parseCatalog(undefined, undefined, value, type);
  return { templates: snapshot.templates, templateSpecs: snapshot.templateSpecs, images: snapshot.images, specs: snapshot.specs };
}

export function resolveCreatePayload(snapshot: CatalogSnapshot, args: CreateSelectionArgs): CreateEnvironmentPayload {
  const wantedType = normalizeType(args.type) ?? args.type.toLowerCase();
  const allGoods = byType(snapshot.goods, wantedType);
  const allSpecs = byType(snapshot.specs, wantedType);
  const allTemplates = byType(snapshot.templates, wantedType);
  const allTemplateSpecs = byType(snapshot.templateSpecs, wantedType);
  const allImages = byType(snapshot.images, wantedType);

  const { selectedGoods, selectedSpec } = resolveMachineSelection(allGoods, allSpecs, args.spec, false);
  const selectedTemplate = chooseOption(allTemplates, args.template, "template", true);
  if (!selectedTemplate) throw new CliError("A template is required.", "CATALOG_SELECTION_ERROR");
  const selectedTemplateSpec = selectTemplateSpec(allTemplateSpecs, selectedTemplate, args.spec);
  const selectedImage = selectImage(allImages, selectedTemplate, args.image);

  const goodsCode = selectedSpec?.goodsCode ?? selectedGoods?.goodsCode ?? selectedGoods?.code;
  const specCode = selectedSpec?.specCode ?? selectedSpec?.code ?? selectedGoods?.specCode;
  const templateCode = selectedTemplate.templateCode ?? selectedTemplate.code;
  const templateSpecCode = selectedTemplateSpec?.templateSpecCode ?? selectedTemplateSpec?.code ?? selectedTemplate.templateSpecCode;
  const imageCode = selectedImage?.imageCode ?? selectedImage?.code ?? selectedTemplate.imageCode;
  if (!goodsCode || !specCode || !templateCode || !templateSpecCode || !imageCode) {
    throw new CliError("The live create catalog is missing one or more required codes (goods/spec/template/template-spec/image). Use `catalog list` to inspect the current options.", "CATALOG_INCOMPLETE", {
      goodsCode,
      specCode,
      templateCode,
      templateSpecCode,
      imageCode,
    });
  }

  const payload: CreateEnvironmentPayload = {
    goods_code: goodsCode,
    spec_code: specCode,
    instance_name: validateInstanceName(args.name),
    template_code: templateCode,
    template_spec_code: templateSpecCode,
    image_code: imageCode,
    template_name: selectedTemplate.name,
    template_spec_name: selectedTemplateSpec?.name,
    image_name: selectedImage?.name,
    cann_version: selectedImage?.version ?? selectedTemplate.version ?? selectedTemplateSpec?.version,
    ...args.repo,
  };
  return omitUndefined(payload as unknown as Record<string, unknown>) as unknown as CreateEnvironmentPayload;
}

export function resolveGoodsSpec(snapshot: CatalogSnapshot, type: string, specSelector: string): { goodsCode: string; specCode: string } {
  const wantedType = normalizeType(type) ?? type.toLowerCase();
  const goods = byType(snapshot.goods, wantedType);
  const specs = byType(snapshot.specs, wantedType);
  const { selectedGoods, selectedSpec } = resolveMachineSelection(goods, specs, specSelector, false);
  const goodsCode = selectedSpec?.goodsCode ?? selectedGoods?.goodsCode ?? selectedGoods?.code;
  const specCode = selectedSpec?.specCode ?? selectedSpec?.code ?? selectedGoods?.specCode;
  if (!goodsCode || !specCode) throw new CliError("The current CANNLab goods catalog did not expose both goods_code and spec_code for the requested --spec.", "CATALOG_INCOMPLETE", { goodsCode, specCode });
  return { goodsCode, specCode };
}

function collectCatalogOptions(value: unknown, result: CatalogSnapshot, wantedType: string | undefined): void {
  walkCatalogObjects(value, (object, path, inherited) => {
    const context = `${path.join(".")} ${Object.keys(object).join(" ")}`.toLowerCase();
    const attributes = isRecord(object.attributes) ? object.attributes : undefined;
    const resourceInfo = isRecord(object.resource_info) ? object.resource_info : undefined;
    const candidateType = normalizeType(firstString(
      object.type,
      object.resource_type,
      object.resourceType,
      attributes?.resourceType,
      attributes?.resource_type,
      resourceInfo?.resource_type,
      object.device_type,
      object.deviceType,
    ));
    const objectType = candidateType === "a2" || candidateType === "a3" || candidateType === "cpu" ? candidateType : inherited.type ?? inferType(context);
    if (wantedType && objectType && objectType !== wantedType) return;

    const goodsCode = firstString(object.goods_code, object.goodsCode, object.product_code, object.productCode);
    const specCode = firstString(object.spec_code, object.specCode, object.resource_spec_code, object.resourceSpecCode);
    const templateCode = firstString(object.template_code, object.templateCode);
    const templateSpecCode = firstString(object.template_spec_code, object.templateSpecCode);
    const imageCode = firstString(object.image_code, object.imageCode, object.image_id, object.imageId);
    const genericCode = firstString(object.code, object.value, object.id, object.key);
    const genericName = firstString(object.name, object.title, object.label, object.text, object.display_name, object.displayName);
    const version = firstString(object.cann_version, object.cannVersion, object.image_version, object.imageVersion, object.version);
    const linkedTemplateCode = templateCode ?? inherited.templateCode;
    const base = (code: string, kind: "goods" | "spec" | "template" | "templateSpec" | "image", name?: string): CatalogOption => ({
      code,
      name,
      type: objectType,
      version,
      goodsCode,
      specCode,
      templateCode: linkedTemplateCode,
      templateSpecCode,
      imageCode,
      raw: object,
    });

    if (goodsCode || (genericCode && isGoodsContext(context))) {
      const code = goodsCode ?? genericCode;
      if (code) result.goods.push(base(code, "goods", firstString(object.goods_name, object.goodsName, genericName)));
    }
    if (specCode || (genericCode && isSpecContext(context))) {
      const code = specCode ?? genericCode;
      if (code) result.specs.push(base(code, "spec", firstString(object.spec_name, object.specName, genericName)));
    }
    if (templateCode || (genericCode && isTemplateContext(context) && !isTemplateSpecContext(context))) {
      const code = templateCode ?? genericCode;
      if (code) result.templates.push(base(code, "template", firstString(object.template_name, object.templateName, genericName)));
    }
    if (templateSpecCode || (genericCode && isTemplateSpecContext(context))) {
      const code = templateSpecCode ?? genericCode;
      if (code) result.templateSpecs.push(base(code, "templateSpec", firstString(object.template_spec_name, object.templateSpecName, object.spec_name, object.specName, genericName)));
    }
    if (imageCode || (genericCode && isImageContext(context))) {
      const code = imageCode ?? genericCode;
      if (code) result.images.push(base(code, "image", firstString(object.image_name, object.imageName, genericName)));
    }

    // Some responses contain one flat row with all five codes. Make each
    // explicitly named value selectable even when the surrounding key is generic.
    if (templateCode && !result.templates.some((item) => item.code === templateCode)) result.templates.push(base(templateCode, "template", firstString(object.template_name, object.templateName, genericName)));
    if (templateSpecCode && !result.templateSpecs.some((item) => item.code === templateSpecCode)) result.templateSpecs.push(base(templateSpecCode, "templateSpec", firstString(object.template_spec_name, object.templateSpecName, genericName)));
    if (imageCode && !result.images.some((item) => item.code === imageCode)) result.images.push(base(imageCode, "image", firstString(object.image_name, object.imageName, genericName)));
  });
}

interface CatalogInheritance {
  type?: string;
  templateCode?: string;
}

function walkCatalogObjects(value: unknown, visitor: (object: Record<string, unknown>, path: string[], inherited: CatalogInheritance) => void, path: string[] = [], inherited: CatalogInheritance = {}, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkCatalogObjects(item, visitor, [...path, String(index)], inherited, seen));
    return;
  }
  const object = value as Record<string, unknown>;
  const rawType = normalizeType(firstString(
    object.type,
    object.resource_type,
    object.resourceType,
    isRecord(object.attributes) ? object.attributes.resourceType : undefined,
    isRecord(object.attributes) ? object.attributes.resource_type : undefined,
    isRecord(object.resource_info) ? object.resource_info.resource_type : undefined,
    object.device_type,
    object.deviceType,
  ));
  const type = rawType === "a2" || rawType === "a3" || rawType === "cpu" ? rawType : inherited.type;
  const templateCode = firstString(object.template_code, object.templateCode) ?? inherited.templateCode;
  const next = { type, templateCode };
  visitor(object, path, inherited);
  for (const [key, child] of Object.entries(object)) walkCatalogObjects(child, visitor, [...path, key], next, seen);
}

function byType(options: CatalogOption[], type: string): CatalogOption[] {
  const typed = options.filter((option) => !option.type || normalizeType(option.type) === type);
  return typed.length ? typed : options;
}

function chooseOption(options: CatalogOption[], selector: string | undefined, label: string, required: boolean): CatalogOption | undefined {
  if (!options.length) {
    if (required) throw new CliError(`No ${label} options were returned by CANNLab.`, "CATALOG_EMPTY");
    return undefined;
  }
  const query = selector?.trim().toLowerCase();
  const exact = query ? options.find((option) => option.code.toLowerCase() === query || option.name?.toLowerCase() === query) : undefined;
  if (exact) return exact;
  if (query) {
    const partial = options.filter((option) => option.code.toLowerCase().includes(query) || option.name?.toLowerCase().includes(query));
    if (partial.length === 1) return partial[0];
    throw new CliError(`Unknown or ambiguous ${label} \`${selector}\`. Choices: ${describeOptions(options)}`, "CATALOG_SELECTION_ERROR");
  }
  if (options.length === 1) return options[0];
  const defaultOption = options.find((option) => isDefault(option.raw));
  if (defaultOption) return defaultOption;
  if (required) throw new CliError(`More than one ${label} was returned; specify --${label}. Choices: ${describeOptions(options)}`, "CATALOG_SELECTION_ERROR");
  return undefined;
}

function selectGoods(options: CatalogOption[], selectedSpec: CatalogOption | undefined, specSelector: string): CatalogOption | undefined {
  if (!options.length) return undefined;
  if (selectedSpec?.goodsCode) {
    const match = options.find((option) => option.code === selectedSpec.goodsCode || option.goodsCode === selectedSpec.goodsCode);
    if (match) return match;
  }
  const embedded = chooseGoodsEmbeddedSpec(options, specSelector);
  if (embedded) return embedded;
  if (options.length === 1) return options[0];
  const defaultOption = options.find((option) => isDefault(option.raw));
  return defaultOption ?? options[0];
}

function resolveMachineSelection(goods: CatalogOption[], specs: CatalogOption[], specSelector: string, strict = true): { selectedGoods: CatalogOption | undefined; selectedSpec: CatalogOption | undefined } {
  let selectedSpec: CatalogOption | undefined;
  try {
    selectedSpec = chooseOption(specs, specSelector, "spec", false);
  } catch (error) {
    if (strict) throw error;
  }
  selectedSpec ??= chooseGoodsEmbeddedSpec(goods, specSelector);
  const selectedGoods = selectGoods(goods, selectedSpec, specSelector);
  return { selectedGoods, selectedSpec };
}

function chooseGoodsEmbeddedSpec(options: CatalogOption[], selector: string): CatalogOption | undefined {
  const query = selector.toLowerCase();
  return options.find((option) => option.specCode?.toLowerCase() === query || option.name?.toLowerCase() === query || option.code.toLowerCase() === query);
}

function selectTemplateSpec(options: CatalogOption[], template: CatalogOption, fallbackSelector: string): CatalogOption | undefined {
  const linked = options.filter((option) => !template.templateCode || option.templateCode === template.templateCode);
  const pool = linked.length ? linked : options;
  if (template.templateSpecCode) return pool.find((option) => option.code === template.templateSpecCode);
  const query = fallbackSelector.trim().toLowerCase();
  const bySelector = pool.find((option) => option.code.toLowerCase() === query || option.name?.toLowerCase() === query);
  if (bySelector) return bySelector;
  if (pool.length === 1) return pool[0];
  const defaultOption = pool.find((option) => isDefault(option.raw));
  if (defaultOption) return defaultOption;
  if (fallbackSelector.trim()) throw new CliError(`Unknown or ambiguous template spec \`${fallbackSelector}\`. Choices: ${describeOptions(pool)}`, "CATALOG_SELECTION_ERROR");
  return pool[0];
}

function selectImage(options: CatalogOption[], template: CatalogOption, selector?: string): CatalogOption | undefined {
  if (template.imageCode && !selector) return options.find((option) => option.code === template.imageCode) ?? { ...template, code: template.imageCode, imageCode: template.imageCode };
  const linked = options.filter((option) => !template.templateCode || !option.templateCode || option.templateCode === template.templateCode);
  return chooseOption(linked.length ? linked : options, selector, "image", false) ?? (linked.length === 1 ? linked[0] : options.length === 1 ? options[0] : undefined);
}

function dedupe(options: CatalogOption[]): CatalogOption[] {
  const merged = new Map<string, CatalogOption>();
  for (const option of options) {
    const key = `${option.code}\u0000${option.type ?? ""}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, option);
      continue;
    }
    merged.set(key, {
      ...previous,
      name: previous.name ?? option.name,
      version: previous.version ?? option.version,
      goodsCode: previous.goodsCode ?? option.goodsCode,
      specCode: previous.specCode ?? option.specCode,
      templateCode: previous.templateCode ?? option.templateCode,
      templateSpecCode: previous.templateSpecCode ?? option.templateSpecCode,
      imageCode: previous.imageCode ?? option.imageCode,
    });
  }
  return [...merged.values()];
}

function inferType(context: string): string | undefined {
  if (/(^|[^a-z0-9])a2([^a-z0-9]|$)|910b/.test(context)) return "a2";
  if (/(^|[^a-z0-9])a3([^a-z0-9]|$)|910c|910d/.test(context)) return "a3";
  if (/(^|[^a-z0-9])cpu([^a-z0-9]|$)/.test(context)) return "cpu";
  return undefined;
}

function isGoodsContext(context: string): boolean { return /goods|product|resource/.test(context) && !isSpecContext(context) && !isTemplateContext(context) && !isImageContext(context); }
function isSpecContext(context: string): boolean { return /(^|[._\s-])spec(s|ification)?([._\s-]|$)|resource_spec/.test(context); }
function isTemplateContext(context: string): boolean { return /template/.test(context); }
function isTemplateSpecContext(context: string): boolean { return /template[_ .-]?spec|templatespec/.test(context); }
function isImageContext(context: string): boolean { return /image|snapshot/.test(context); }
function isDefault(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Boolean(value.default ?? value.is_default ?? value.isDefault ?? value.selected ?? value.checked);
}

function describeOptions(options: CatalogOption[]): string {
  return options.slice(0, 20).map((option) => option.name ? `${option.code} (${option.name})` : option.code).join(", ");
}

function validateInstanceName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 32) throw new CliError("Instance name must be between 1 and 32 characters.", "INVALID_INSTANCE_NAME");
  return value;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

// Keep this import/use visible to TypeScript when the API returns a primitive
// envelope in a fixture; it also documents that catalog parsing starts at data.
export function catalogData(value: unknown): unknown { return unwrapData(value); }
