import { ApiError, CliError } from "./errors.js";
import { collectObjects, firstString, isRecord, normalizeStatus, normalizeType, unwrapData } from "./utils.js";
import type { ResourceSummary } from "./types.js";

const KEY_FIELDS = ["instance_key", "instanceKey", "resource_key", "resourceKey", "env_key", "envKey", "instance_id", "instanceId", "id", "key"];

export function extractResourceList(body: unknown): ResourceSummary[] {
  const candidates: unknown[][] = [];
  walkArrays(body, candidates, new Set<unknown>());
  const preferred = candidates.sort((a, b) => scoreArray(b) - scoreArray(a))[0] ?? [];
  const source = preferred.length ? preferred : collectResourceObjects(body);
  const result: ResourceSummary[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const normalized = normalizeResource(item);
    if (!normalized || seen.has(normalized.instanceKey)) continue;
    seen.add(normalized.instanceKey);
    result.push(normalized);
  }
  return result;
}

export function normalizeResource(body: unknown): ResourceSummary | undefined {
  const object = findResourceObject(body);
  if (!object) return undefined;
  const instanceKey = firstString(...KEY_FIELDS.map((key) => object[key]));
  if (!instanceKey) return undefined;
  const statusRaw = firstString(object.status, object.state, object.instance_status, object.instanceStatus, object.resource_status, object.resourceStatus, object.phase, object.status_name, object.statusName, object.status_code, object.statusCode);
  return {
    instanceKey,
    pairId: firstString(object.pair_id, object.pairId, object.resource_pair_id, object.resourcePairId),
    name: firstString(object.instance_name, object.instanceName, object.name, object.resource_name, object.resourceName),
    type: normalizeType(firstString(object.type, object.resource_type, object.resourceType, object.device_type, object.deviceType, object.goods_type, object.goodsType)),
    status: normalizeStatus(statusRaw),
    statusRaw,
    createdAt: firstString(object.created_at, object.createdAt, object.create_time, object.createTime),
    updatedAt: firstString(object.updated_at, object.updatedAt, object.update_time, object.updateTime),
    raw: object,
  };
}

export function findResourceById(resources: ResourceSummary[], id: string, idType: "instance" | "pair"): ResourceSummary | undefined {
  const query = id.trim();
  return resources.find((resource) => idType === "pair" ? resource.pairId === query : resource.instanceKey === query);
}

export function getStatus(body: unknown): string | undefined {
  const resource = normalizeResource(body);
  if (resource?.status) return resource.status;
  let result: string | undefined;
  collectObjects(body, (object) => {
    if (result) return;
    const raw = firstString(object.status, object.state, object.status_code, object.statusCode, object.task_status, object.taskStatus, object.phase, object.result_status, object.resultStatus);
    if (raw) result = normalizeStatus(raw);
  });
  return result;
}

export function isSuccessfulStatus(status: string | undefined, desired: "running" | "stopped" | "deleted" | "upgrade"): boolean {
  if (desired === "running") return status === "running";
  if (desired === "stopped") return status === "stopped";
  if (desired === "deleted") return status === "deleted";
  // The upgrade endpoint reports PROCESSING as "running" after generic
  // status normalization. That is transitional, so only task-terminal
  // success values satisfy an upgrade poll.
  return ["success", "succeeded", "completed", "finished", "done"].includes(status ?? "");
}

export function assertNotFailed(status: string | undefined, action: string): void {
  if (status === "failed") throw new CliError(`CANNLab ${action} entered a failed state.`, "REMOTE_OPERATION_FAILED", { status });
}

function findResourceObject(body: unknown): Record<string, unknown> | undefined {
  const unwrapped = unwrapData(body);
  if (isRecord(unwrapped)) {
    for (const key of ["resource", "instance", "item", "data"]) {
      const child = unwrapped[key];
      if (isRecord(child) && firstString(...KEY_FIELDS.map((field) => child[field]))) return child;
    }
    if (firstString(...KEY_FIELDS.map((field) => unwrapped[field]))) return unwrapped;
  }
  let found: Record<string, unknown> | undefined;
  collectObjects(unwrapped, (object) => {
    if (!found && firstString(...KEY_FIELDS.map((field) => object[field]))) found = object;
  });
  return found;
}

function walkArrays(value: unknown, result: unknown[][], seen: Set<unknown>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.some((item) => isRecord(item))) result.push(value);
    for (const item of value) walkArrays(item, result, seen);
    return;
  }
  for (const child of Object.values(value)) walkArrays(child, result, seen);
}

function scoreArray(items: unknown[]): number {
  return items.reduce<number>((score, item) => score + (isRecord(item) && firstString(...KEY_FIELDS.map((field) => item[field])) ? 10 : 0), 0);
}

function collectResourceObjects(body: unknown): unknown[] {
  const result: unknown[] = [];
  collectObjects(body, (object) => {
    if (firstString(...KEY_FIELDS.map((field) => object[field]))) result.push(object);
  });
  return result;
}

export function isNotFound(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.api.status === 404) return true;
  const code = String(error.api.errorCode ?? "").toLowerCase();
  const codeName = (error.api.errorCodeName ?? "").toLowerCase();
  const message = error.api.errorMessage.toLowerCase();
  return code === "404" || /not[_ -]?found|resource[_ -]?not[_ -]?exist/.test(codeName) || /not found|does not exist/.test(message);
}
