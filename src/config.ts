import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { parse as parseDotenv } from "dotenv";

import { CliError } from "./errors.js";
import { parseDuration } from "./utils.js";
import type { RuntimeOptions } from "./types.js";

export const DEFAULT_API_BASE = "https://web-api.gitcode.com/score-proxy/api/v1/shop/third-party";
export const DEFAULT_AUTH_FILE = resolve(homedir(), ".config", "cannlab-envpilot", "auth.json");
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;

export interface Settings {
  apiBase: string;
  authFile: string;
  envFile: string;
  accessToken?: string;
  accessTokenSource?: "cli" | "environment";
  refreshToken?: string;
  dotenvAccessToken?: string;
  dotenvRefreshToken?: string;
  gitcodeAccount?: string;
  gitcodePassword?: string;
  aesKey: string;
  aesIv: string;
  gitcodeAuthBase: string;
  gitcodeXSource?: string;
  timeoutMs: number;
  pollIntervalMs: number;
  wait: boolean;
  json: boolean;
}

export interface DotEnvLoadResult {
  path: string;
  values: Record<string, string>;
}

export function loadDotEnvFile(filePath = resolve(process.cwd(), ".env")): DotEnvLoadResult {
  const path = resolve(filePath);
  if (!existsSync(path)) return { path, values: {} };
  try {
    const values = parseDotenv(readFileSync(path));
    // Credentials in a project-local .env should never be group/world readable.
    chmodSync(path, 0o600);
    return { path, values };
  } catch (error) {
    throw new CliError(`Unable to read environment file ${path}: ${error instanceof Error ? error.message : String(error)}`, "ENV_FILE_ERROR");
  }
}

export function resolveSettings(overrides: RuntimeOptions = {}, cwd = process.cwd()): Settings {
  const envFile = resolve(overrides.envFile ?? process.env.CANNLAB_ENV_FILE ?? resolve(cwd, ".env"));
  const dotenvValues = loadDotEnvFile(envFile).values;
  const processValue = (...keys: string[]): string | undefined => firstNonEmpty(keys.map((key) => process.env[key]));
  const dotenvValue = (...keys: string[]): string | undefined => firstNonEmpty(keys.map((key) => dotenvValues[key]));
  const mixedValue = (...keys: string[]): string | undefined => processValue(...keys) ?? dotenvValue(...keys);

  const apiBase = normalizeBase(overrides.apiBase ?? processValue("CANNLAB_API_BASE") ?? dotenvValue("CANNLAB_API_BASE") ?? DEFAULT_API_BASE);
  const authFile = resolve(overrides.authFile ?? processValue("CANNLAB_AUTH_FILE") ?? dotenvValue("CANNLAB_AUTH_FILE") ?? DEFAULT_AUTH_FILE);
  const timeoutInput = overrides.timeout ?? processValue("CANNLAB_TIMEOUT_SECONDS") ?? dotenvValue("CANNLAB_TIMEOUT_SECONDS");
  const intervalInput = overrides.interval ?? processValue("CANNLAB_POLL_INTERVAL_SECONDS") ?? dotenvValue("CANNLAB_POLL_INTERVAL_SECONDS");
  const cliAccess = firstNonEmpty([overrides.accessToken]);
  const environmentAccess = processValue("CANNLAB_ACCESS_TOKEN", "GITCODE_ACCESS_TOKEN");
  const dotenvAccess = dotenvValue("CANNLAB_ACCESS_TOKEN", "GITCODE_ACCESS_TOKEN");
  const accessToken = cliAccess ?? environmentAccess;
  const accessTokenSource = cliAccess ? "cli" : environmentAccess ? "environment" : undefined;
  const cliRefresh = firstNonEmpty([overrides.refreshToken]);
  const environmentRefresh = processValue("CANNLAB_REFRESH_TOKEN", "GITCODE_REFRESH_TOKEN");
  const dotenvRefresh = dotenvValue("CANNLAB_REFRESH_TOKEN", "GITCODE_REFRESH_TOKEN");
  const refreshToken = cliRefresh ?? environmentRefresh;

  return {
    apiBase,
    authFile,
    envFile,
    accessToken,
    accessTokenSource,
    refreshToken,
    dotenvAccessToken: dotenvAccess,
    dotenvRefreshToken: dotenvRefresh,
    gitcodeAccount: mixedValue("GITCODE_ACCOUNT", "gitcode-account", "gitcode_account", "GITCODE-ACCOUNT"),
    gitcodePassword: mixedValue("GITCODE_PASSWORD", "gitcode-password", "gitcode_password", "GITCODE-PASSWORD"),
    aesKey: mixedValue("GITCODE_AES_KEY") ?? "SA!nUNPZ5o!OSV&B",
    aesIv: mixedValue("GITCODE_AES_IV") ?? "SA!nwwwZ5o!OSV&B",
    gitcodeAuthBase: normalizeBase(mixedValue("GITCODE_AUTH_BASE") ?? "https://web-api.gitcode.com"),
    gitcodeXSource: mixedValue("GITCODE_X_SOURCE"),
    timeoutMs: parseDuration(timeoutInput, DEFAULT_TIMEOUT_MS),
    pollIntervalMs: parseDuration(intervalInput, DEFAULT_POLL_INTERVAL_MS),
    wait: overrides.wait ?? true,
    json: overrides.json ?? false,
  };
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}

function normalizeBase(value: string): string {
  const base = value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("must use http or https");
    return base;
  } catch (error) {
    throw new CliError(`Invalid CANNLAB_API_BASE: ${error instanceof Error ? error.message : String(error)}`, "CONFIG_ERROR");
  }
}
