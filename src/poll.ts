import { ApiError, PollTimeoutError } from "./errors.js";
import { sleep } from "./utils.js";
import { assertNotFailed, getStatus, isNotFound, isSuccessfulStatus } from "./resources.js";
import type { PollOptions } from "./types.js";

export interface GenericPollOptions<T> extends PollOptions {
  read: () => Promise<T>;
  done: (value: T) => boolean;
  describe?: (value: T) => string;
  action: string;
}

export async function pollUntil<T>(options: GenericPollOptions<T>): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (true) {
    if (Date.now() - started > options.timeoutMs) throw new PollTimeoutError(`Timed out waiting for ${options.action} after ${Math.round(options.timeoutMs / 1000)} seconds`, { last });
    last = await options.read();
    if (options.describe && options.onProgress) options.onProgress(options.describe(last));
    if (options.done(last)) return last;
    const remaining = options.timeoutMs - (Date.now() - started);
    await sleep(Math.min(options.intervalMs, Math.max(0, remaining)), options.signal);
  }
}

export async function waitForResource(getResource: () => Promise<unknown>, desired: "running" | "stopped", options: PollOptions): Promise<unknown> {
  if (!options.wait) return getResource();
  return pollUntil({
    ...options,
    action: desired === "running" ? "environment to become running" : "environment to stop",
    read: getResource,
    done: (body) => {
      const status = getStatus(body);
      assertNotFailed(status, desired === "running" ? "start" : "stop");
      return isSuccessfulStatus(status, desired);
    },
    describe: (body) => `status=${getStatus(body) ?? "unknown"}`,
  });
}

export async function waitForProvisioned(getResource: () => Promise<unknown>, options: PollOptions): Promise<unknown> {
  if (!options.wait) return getResource();
  return pollUntil({
    ...options,
    action: "environment provisioning",
    read: getResource,
    done: (body) => {
      const status = getStatus(body);
      assertNotFailed(status, "create");
      if (["deleting", "unknown"].includes(status ?? "")) return false;
      // OPENING/3 is transitional in the web UI; wait for a usable state.
      return ["running", "stopped"].includes(status ?? "");
    },
    describe: (body) => `status=${getStatus(body) ?? "unknown"}`,
  });
}

export async function waitForDeletion(getResource: () => Promise<unknown>, options: PollOptions): Promise<unknown> {
  if (!options.wait) return null;
  return pollUntil({
    ...options,
    action: "environment deletion",
    read: async () => {
      try {
        return await getResource();
      } catch (error) {
        if (isNotFound(error)) return DELETED;
        throw error;
      }
    },
    done: (body) => body === DELETED || isSuccessfulStatus(getStatus(body), "deleted"),
    describe: (body) => body === DELETED ? "status=deleted" : `status=${getStatus(body) ?? "unknown"}`,
  });
}

export async function waitForUpgrade(getUpgrade: () => Promise<unknown>, options: PollOptions): Promise<unknown> {
  if (!options.wait) return getUpgrade();
  return pollUntil({
    ...options,
    action: "CANN version upgrade",
    read: getUpgrade,
    done: (body) => {
      const status = getStatus(body);
      assertNotFailed(status, "upgrade");
      return isSuccessfulStatus(status, "upgrade");
    },
    describe: (body) => `upgrade=${getStatus(body) ?? "unknown"}`,
  });
}

const DELETED = Symbol("deleted");
