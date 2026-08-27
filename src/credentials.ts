import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { atomicWriteJson } from "./utils.js";
import { CliError } from "./errors.js";

export async function writeCredentialResponse(path: string, response: unknown, force = false): Promise<{ path: string }> {
  const target = resolve(path);
  if (!force) {
    try {
      await lstat(target);
      throw new CliError(`Refusing to overwrite existing credential file: ${target}`, "OUTPUT_EXISTS");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await atomicWriteJson(target, response, { mode: 0o600, force });
  return { path: target };
}
