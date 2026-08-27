import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { CliError } from "./errors.js";
import type { AuthCache } from "./types.js";
import { atomicWriteJson } from "./utils.js";

const AuthCacheSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  account: z.string().optional(),
  account_info: z.record(z.string(), z.unknown()).optional(),
}).strict();

export async function loadAuthCache(path: string): Promise<AuthCache | undefined> {
  const target = resolve(path);
  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    const result = AuthCacheSchema.safeParse(parsed);
    if (!result.success) throw new CliError(`Invalid auth cache at ${target}`, "AUTH_CACHE_ERROR", result.error.flatten());
    await chmod(target, 0o600).catch(() => undefined);
    return result.data as AuthCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof CliError) throw error;
    throw new CliError(`Unable to read auth cache ${target}: ${error instanceof Error ? error.message : String(error)}`, "AUTH_CACHE_ERROR");
  }
}

export async function saveAuthCache(path: string, cache: AuthCache): Promise<void> {
  const target = resolve(path);
  const valid = AuthCacheSchema.safeParse(cache);
  if (!valid.success) throw new CliError("Refusing to save an invalid auth cache", "AUTH_CACHE_ERROR", valid.error.flatten());
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700).catch(() => undefined);
  try {
    await atomicWriteJson(target, valid.data, { mode: 0o600, force: true });
  } catch (error) {
    throw new CliError(`Unable to save auth cache ${target}: ${error instanceof Error ? error.message : String(error)}`, "AUTH_CACHE_ERROR");
  }
}

export async function clearAuthCache(path: string): Promise<boolean> {
  try {
    await rm(resolve(path), { force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CliError(`Unable to remove auth cache: ${error instanceof Error ? error.message : String(error)}`, "AUTH_CACHE_ERROR");
  }
}

export async function authCacheMetadata(path: string): Promise<{ exists: boolean; mode?: number; modifiedAt?: string }> {
  try {
    const info = await stat(resolve(path));
    return { exists: true, mode: info.mode & 0o777, modifiedAt: info.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}
