import { CliError, PollTimeoutError } from "./errors.js";
import { parseCatalog, resolveCreatePayload, resolveGoodsSpec, type CreateSelectionArgs } from "./catalog.js";
import { extractResourceList, getStatus, isNotFound, normalizeResource } from "./resources.js";
import { waitForDeletion, waitForProvisioned, waitForResource, waitForUpgrade } from "./poll.js";
import type { CannlabApiClient } from "./api.js";
import type { PollOptions, ResourceSummary } from "./types.js";

export interface EnvironmentServiceOptions {
  api: CannlabApiClient;
  poll: PollOptions;
  progress?: (message: string) => void;
}

export class EnvironmentService {
  constructor(private readonly options: EnvironmentServiceOptions) {}

  async catalog(type?: string): Promise<ReturnType<typeof parseCatalog>> {
    const access = await this.options.api.getCreateAccess();
    const goods = await this.options.api.getCreateGoods();
    const preliminary = parseCatalog(access, goods, undefined, type);
    const pairs = new Set<string>();
    for (const option of preliminary.specs) {
      const goodsCode = option.goodsCode ?? (isRecord(option.raw) ? firstStringValue(option.raw.goods_code, option.raw.goodsCode) : undefined);
      const specCode = option.specCode ?? option.code;
      if (goodsCode && specCode) pairs.add(`${goodsCode}\u0000${specCode}`);
    }
    const configs: unknown[] = [];
    if (pairs.size === 0) configs.push(await this.options.api.getCreateConfig());
    else for (const pair of pairs) {
      const [goodsCode, specCode] = pair.split("\u0000");
      configs.push(await this.options.api.getCreateConfig(goodsCode, specCode));
    }
    return parseCatalog(access, goods, configs, type);
  }

  async list(): Promise<{ resources: ResourceSummary[]; raw: unknown[] }> {
    const pages: unknown[] = [];
    const resources: ResourceSummary[] = [];
    const seen = new Set<string>();
    let page = 1;
    while (page <= 100) {
      const body = await this.options.api.getResources(page, 100);
      pages.push(body);
      const pageItems = extractResourceList(body);
      for (const item of pageItems) {
        if (!seen.has(item.instanceKey)) {
          seen.add(item.instanceKey);
          resources.push(item);
        }
      }
      if (!hasMore(body, pageItems.length, page)) break;
      page += 1;
    }
    return { resources, raw: pages };
  }

  async show(instanceKey: string, idType: "instance" | "pair" = "instance"): Promise<{ resource?: ResourceSummary; raw: unknown }> {
    const raw = await this.options.api.getResource(instanceKey, idType);
    return { resource: normalizeResource(raw), raw };
  }

  async create(args: CreateSelectionArgs): Promise<{ payload: unknown; response: unknown; resource?: ResourceSummary }> {
    this.progress(`Reading the current ${args.type} create catalog`);
    const access = await this.options.api.getCreateAccess();
    const goods = await this.options.api.getCreateGoods();
    const preliminary = parseCatalog(access, goods, undefined, args.type);
    const machine = resolveGoodsSpec(preliminary, args.type, args.spec);
    const config = await this.options.api.getCreateConfig(machine.goodsCode, machine.specCode);
    const catalog = parseCatalog(access, goods, config, args.type);
    const payload = resolveCreatePayload(catalog, args);
    const response = await this.options.api.createEnvironment(payload);
    const resource = normalizeResource(response);
    if (this.options.poll.wait) {
      const key = resource?.instanceKey ?? extractKey(response);
      if (!key) throw new CliError("CANNLab accepted the create request but returned no instance key; inspect `env list` before retrying.", "CREATE_KEY_MISSING", { response });
      const final = await waitForProvisioned(() => this.options.api.getResource(key), this.pollOptions());
      return { payload, response, resource: normalizeResource(final) ?? resource };
    }
    return { payload, response, resource };
  }

  async start(instanceKey: string): Promise<unknown> {
    const response = await this.options.api.start(instanceKey);
    if (!this.options.poll.wait) return response;
    return waitForResource(() => this.options.api.getResource(instanceKey), "running", this.pollOptions());
  }

  async stop(instanceKey: string): Promise<unknown> {
    const response = await this.options.api.stop(instanceKey);
    if (!this.options.poll.wait) return response;
    return waitForResource(() => this.options.api.getResource(instanceKey), "stopped", this.pollOptions());
  }

  async delete(id: string, idType: "instance" | "pair"): Promise<unknown> {
    const response = await this.options.api.delete(id, idType);
    if (!this.options.poll.wait) return response;
    return waitForDeletion(() => this.options.api.getResource(id, idType), this.pollOptions());
  }

  async upgrade(instanceKey: string, version: string | undefined): Promise<{ script: unknown; response?: unknown; result?: unknown }> {
    const scripts = await this.options.api.getScripts(instanceKey);
    const script = findCannUpdateScript(scripts);
    if (!script) throw new CliError("CANNLab did not expose an UPDATE_CANN_VERSION script for this environment.", "UPGRADE_SCRIPT_MISSING");
    const targetVersion = version ?? findVersion(script);
    if (!targetVersion) throw new CliError("The update script does not expose a default target version; specify --version.", "UPGRADE_VERSION_REQUIRED");
    const scriptId = findScriptId(script);
    if (!scriptId) throw new CliError("The UPDATE_CANN_VERSION script has no script_id.", "UPGRADE_SCRIPT_INVALID");
    const response = await this.options.api.upgrade(instanceKey, scriptId, targetVersion);
    if (!this.options.poll.wait) return { script, response };
    const result = await waitForUpgrade(() => this.options.api.getUpgrade(instanceKey), this.pollOptions());
    return { script, response, result };
  }

  private progress(message: string): void {
    this.options.progress?.(message);
  }

  private pollOptions(): PollOptions {
    return { ...this.options.poll, onProgress: this.options.progress };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstStringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function hasMore(body: unknown, count: number, page: number): boolean {
  if (!count) return false;
  const objects: Record<string, unknown>[] = [];
  walkObjects(body, objects, new Set<unknown>());
  for (const object of objects) {
    const total = numberValue(object.total, object.total_count, object.totalCount, object.count);
    const pages = numberValue(object.pages, object.total_pages, object.totalPages, object.page_count, object.pageCount);
    const current = numberValue(object.page, object.current_page, object.currentPage, object.page_num, object.pageNum) ?? page;
    const perPage = numberValue(object.per_page, object.perPage, object.page_size, object.pageSize) ?? count;
    if (pages !== undefined) return current < pages;
    if (total !== undefined) return page * perPage < total;
    if (object.has_more === true || object.hasMore === true) return true;
  }
  return count >= 100;
}

function extractKey(body: unknown): string | undefined {
  return normalizeResource(body)?.instanceKey;
}

function findCannUpdateScript(body: unknown): Record<string, unknown> | undefined {
  const candidates: Record<string, unknown>[] = [];
  walkObjects(body, candidates, new Set<unknown>());
  return candidates.find((object) => /UPDATE_CANN_VERSION/i.test(String(object.name ?? object.script_name ?? object.scriptName ?? object.code ?? object.script_code ?? "")));
}

function findScriptId(script: Record<string, unknown>): string | undefined {
  for (const key of ["script_id", "scriptId", "id", "key"]) {
    const value = script[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return undefined;
}

function findVersion(script: Record<string, unknown>): string | undefined {
  for (const key of ["target_version", "targetVersion", "default_version", "defaultVersion", "latest_version", "latestVersion", "version"]) {
    const value = script[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function walkObjects(value: unknown, result: Record<string, unknown>[], seen: Set<unknown>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) walkObjects(child, result, seen);
    return;
  }
  const object = value as Record<string, unknown>;
  result.push(object);
  for (const child of Object.values(object)) walkObjects(child, result, seen);
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}
