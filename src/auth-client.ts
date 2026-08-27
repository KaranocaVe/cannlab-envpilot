import { encryptGitCodePassword } from "./crypto.js";
import { AuthError, CaptchaRequiredError } from "./errors.js";
import type { Settings } from "./config.js";

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  account?: string;
  accountInfo?: Record<string, unknown>;
}

export interface AuthClientOptions {
  fetchImpl?: typeof fetch;
}

export class GitCodeAuthClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly settings: Settings, options: AuthClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async loginWithPassword(account: string, password: string, captcha: Record<string, string> = {}): Promise<AuthTokens> {
    const form = new URLSearchParams();
    form.set("username", account);
    form.set("password", encryptGitCodePassword(password, this.settings.aesKey, this.settings.aesIv));
    form.set("captcha_id", captcha.captcha_id ?? "");
    form.set("token", captcha.token ?? "");
    form.set("authenticate", captcha.authenticate ?? "");
    form.set("validate", captcha.validate ?? "");
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": BROWSER_USER_AGENT,
      origin: "https://gitcode.com",
      referer: "https://gitcode.com/",
    };
    if (this.settings.gitcodeXSource) headers["X-Source"] = this.settings.gitcodeXSource;
    const response = await this.fetchImpl(`${this.settings.gitcodeAuthBase}/uc/api/v1/user/oauth/login`, { method: "POST", headers, body: form });
    const body = await parseBody(response);
    const apiError = responseError(response.status, body);
    if (apiError) {
      if (looksLikeChallenge(apiError.message)) throw new CaptchaRequiredError(apiError.message);
      throw new AuthError(apiError.message, apiError.body);
    }
    const tokens = extractTokens(body);
    if (!tokens.accessToken) {
      const message = extractMessage(body) ?? "GitCode password login did not return an access token";
      if (looksLikeChallenge(message)) throw new CaptchaRequiredError(message);
      throw new AuthError(message, body);
    }
    return tokens;
  }

  async refresh(accessToken: string, refreshToken: string): Promise<AuthTokens> {
    const form = new URLSearchParams({ refresh_token: refreshToken });
    const response = await this.fetchImpl(`${this.settings.gitcodeAuthBase}/uc/api/v1/user/token/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": BROWSER_USER_AGENT,
        origin: "https://gitcode.com",
        referer: "https://gitcode.com/",
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    });
    const body = await parseBody(response);
    const apiError = responseError(response.status, body);
    if (apiError) throw new AuthError(`GitCode token refresh failed: ${apiError.message}`, apiError.body);
    const tokens = extractTokens(body);
    if (!tokens.accessToken) throw new AuthError("GitCode token refresh did not return an access token", body);
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  }
}

export function extractTokens(body: unknown): AuthTokens {
  const candidates = candidateObjects(body);
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let account: string | undefined;
  let accountInfo: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    accessToken ??= stringField(candidate, ["access_token", "accessToken", "access-token", "web_access_token"]);
    refreshToken ??= stringField(candidate, ["refresh_token", "refreshToken", "refresh-token"]);
    account ??= stringField(candidate, ["username", "user_name", "userName", "account", "login", "name"]);
    if (!accountInfo) {
      const user = candidate.user ?? candidate.user_info ?? candidate.userInfo ?? candidate.account_info ?? candidate.accountInfo;
      if (isObject(user)) accountInfo = stripSecrets(user);
    }
  }
  return { accessToken: accessToken ?? "", refreshToken, account, accountInfo };
}

export function extractMessage(body: unknown): string | undefined {
  const candidates = candidateObjects(body);
  for (const candidate of candidates) {
    const message = stringField(candidate, ["error_message", "errorMessage"]);
    if (message) return message;
  }
  for (const candidate of candidates) {
    const message = stringField(candidate, ["message", "msg", "detail"]);
    if (message) return message;
  }
  return undefined;
}

function candidateObjects(value: unknown, result: Record<string, unknown>[] = [], seen = new Set<unknown>()): Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) candidateObjects(child, result, seen);
    return result;
  }
  if (!isObject(value)) return result;
  result.push(value);
  for (const key of ["data", "result", "payload", "body", "error", "user", "user_info", "userInfo"]) {
    const child = value[key];
    if (isObject(child)) candidateObjects(child, result, seen);
  }
  return result;
}

function stringField(object: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = object[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(token|password|secret|cookie|xauth|authorization)/i.test(key)) continue;
    if (isObject(child)) result[key] = stripSecrets(child);
    else if (Array.isArray(child)) result[key] = child.map((item) => isObject(item) ? stripSecrets(item) : item);
    else result[key] = child;
  }
  return result;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseError(status: number, body: unknown): { message: string; body: unknown } | undefined {
  const candidates = candidateObjects(body);
  const message = extractMessage(body);
  const code = findCode(body);
  const hasErrorObject = candidates.some((candidate) => hasMeaningfulErrorField(candidate, "error") || hasMeaningfulErrorField(candidate, "errors") || candidate.success === false || candidate.ok === false || "error_message" in candidate || "errorMessage" in candidate);
  const badCode = code !== undefined && !isSuccessCode(code);
  if (status >= 400 || hasErrorObject || badCode) {
    const fallback = typeof body === "string" ? summarizeText(body) : undefined;
    return { message: message ?? fallback ?? `GitCode authentication request failed with HTTP ${status}`, body: summarizeBody(body) };
  }
  return undefined;
}

function hasMeaningfulErrorField(object: Record<string, unknown>, key: "error" | "errors"): boolean {
  if (!(key in object)) return false;
  const value = object[key];
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function isSuccessCode(value: string | number): boolean {
  if (typeof value === "number") return value === 0 || (value >= 200 && value < 300);
  const normalized = value.trim().toUpperCase();
  if (["0", "OK", "SUCCESS", "TRUE"].includes(normalized)) return true;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric >= 200 && numeric < 300;
}

function findCode(body: unknown): string | number | undefined {
  const candidates = candidateObjects(body);
  for (const candidate of candidates) {
    for (const key of ["error_code", "errorCode"]) {
      const value = candidate[key];
      if (typeof value === "string" || typeof value === "number") return value;
    }
  }
  for (const candidate of candidates) {
    for (const key of ["code", "status_code", "statusCode"]) {
      const value = candidate[key];
      if (typeof value === "string" || typeof value === "number") return value;
    }
  }
  return undefined;
}

function looksLikeChallenge(message: string): boolean {
  return /(captcha|verify|verification|mfa|易盾|验证码|二次认证|challenge|滑块|waf|attack|拦截|攻击行为)/i.test(message);
}

function summarizeBody(value: unknown): unknown {
  if (typeof value === "string") return summarizeText(value);
  return value;
}

function summarizeText(value: string): string {
  const plain = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain.slice(0, 500);
}

const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
