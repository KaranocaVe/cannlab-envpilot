import { promises as fs, constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import type { JsonObject, JsonValue } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1 || value === "1") return true;
    if (value === "false" || value === 0 || value === "0") return false;
  }
  return undefined;
}

export function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeType(value: unknown): string | undefined {
  const normalized = lower(value).replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (["a2", "ascend2", "npu", "910", "910b", "910b4"].includes(normalized)) return "a2";
  if (["a3", "ascend3", "910c", "910d"].includes(normalized)) return "a3";
  if (["cpu", "x86", "amd", "intel"].includes(normalized)) return "cpu";
  return lower(value);
}

export function normalizeStatus(value: unknown): string | undefined {
  const raw = lower(value).replace(/[\s-]+/g, "_");
  if (!raw) return undefined;
  if (["0", "to_be_created", "tobecreated"].includes(raw)) return "to_be_created";
  if (raw === "1") return "initializing";
  if (raw === "2") return "running";
  if (raw === "3") return "opening";
  if (raw === "4") return "stopped";
  if (raw === "5") return "stopping";
  if (raw === "6") return "deleting";
  if (raw === "7") return "archiving";
  if (raw === "8") return "restarting";
  if (raw === "9") return "unknown";
  if (raw === "-1") return "failed";
  if (["create", "created", "creating", "provisioning", "pending", "queued", "init", "initializing"].includes(raw)) return "creating";
  if (["open", "opened", "opening", "start", "starting", "booting", "available", "ready", "running", "run", "processing"].includes(raw)) return ["running", "run", "processing"].includes(raw) ? "running" : "opening";
  if (["stop", "stopping", "halting", "shutting_down"].includes(raw)) return "stopping";
  if (["stopped", "stoped", "shutdown", "shut_down", "closed", "close"].includes(raw)) return "stopped";
  if (["delete", "deleting", "terminating", "releasing"].includes(raw)) return "deleting";
  if (["deleted", "destroyed", "released", "not_found", "notfound"].includes(raw)) return "deleted";
  if (["fail", "failed", "error", "abnormal", "exception", "create_failed", "createfailed"].includes(raw)) return "failed";
  return raw;
}

export function unwrapData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("data" in value && value.data !== undefined) return value.data;
  if ("result" in value && value.result !== undefined) return value.result;
  return value;
}

export function parseDuration(value: string | number | undefined, fallbackMs: number): number {
  if (value === undefined || value === null || value === "") return fallbackMs;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid duration: ${value}`);
    return Math.round(value * 1000);
  }
  const text = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 1_000;
  return Math.round(amount * multiplier);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    if (!signal) return;
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function safeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => safeJson(item));
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = safeJson(item);
    }
    return result;
  }
  return String(value);
}

export function jsonString(value: unknown): string {
  return JSON.stringify(safeJson(value), null, 2);
}

export async function atomicWriteJson(path: string, value: unknown, options: { mode?: number; force?: boolean } = {}): Promise<void> {
  const target = resolve(path);
  const mode = options.mode ?? 0o600;
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (!options.force) {
    try {
      await fs.access(target, fsConstants.F_OK);
      throw new Error(`Refusing to overwrite existing file: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(`${jsonString(value)}\n`, "utf8");
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await fs.chmod(target, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writePrivateFile(path: string, content: string, options: { force?: boolean } = {}): Promise<void> {
  await atomicWriteJson(path, { content }, options);
}

export function formatTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return "(empty)";
  const keys = columns?.length ? columns : Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const values = rows.map((row) => keys.map((key) => printable(row[key])));
  const widths = keys.map((key, index) => Math.max(key.length, ...values.map((row) => row[index]?.length ?? 0)));
  const line = (row: string[]) => row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd();
  return [line(keys), line(widths.map((width) => "-".repeat(width))), ...values.map(line)].join("\n");
}

function printable(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function collectObjects(value: unknown, visitor: (object: Record<string, unknown>, path: string[]) => void, path: string[] = [], seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectObjects(item, visitor, [...path, String(index)], seen));
    return;
  }
  const object = value as Record<string, unknown>;
  visitor(object, path);
  for (const [key, child] of Object.entries(object)) collectObjects(child, visitor, [...path, key], seen);
}

export function hasText(value: unknown, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.length > 0 && typeof value === "string" && value.trim().toLowerCase() === normalized;
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
