import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";

import { loadAuthCache, saveAuthCache } from "./auth-store.js";
import { extractMessage, GitCodeAuthClient, type AuthTokens } from "./auth-client.js";
import { AuthError, CaptchaRequiredError, redact } from "./errors.js";
import type { Settings } from "./config.js";
import type { AuthCache, TokenSet } from "./types.js";

export interface AuthManagerOptions {
  fetchImpl?: typeof fetch;
  prompt?: (message: string) => Promise<string>;
  validateToken?: (token: string) => Promise<void>;
}

export class AuthManager {
  private current?: TokenSet;
  private readonly authClient: GitCodeAuthClient;
  private readonly prompt: (message: string) => Promise<string>;

  constructor(private readonly settings: Settings, private readonly options: AuthManagerOptions = {}) {
    this.authClient = new GitCodeAuthClient(settings, { fetchImpl: options.fetchImpl });
    this.prompt = options.prompt ?? defaultPrompt;
  }

  async resolve(): Promise<TokenSet> {
    if (this.current) return this.current;
    if (this.settings.accessToken) {
      this.current = {
        accessToken: this.settings.accessToken,
        refreshToken: this.settings.refreshToken,
        persist: false,
        source: this.settings.accessTokenSource ?? "environment",
      };
      return this.current;
    }
    const cached = await loadAuthCache(this.settings.authFile);
    if (cached) {
      this.current = fromCache(cached);
      return this.current;
    }
    if (this.settings.dotenvAccessToken) {
      this.current = {
        accessToken: this.settings.dotenvAccessToken,
        refreshToken: this.settings.dotenvRefreshToken,
        persist: false,
        source: "dotenv",
      };
      return this.current;
    }
    if (this.settings.gitcodeAccount && this.settings.gitcodePassword) {
      try {
        this.current = await this.loginWithCredentials(this.settings.gitcodeAccount, this.settings.gitcodePassword, true);
      } catch (error) {
        if (!(error instanceof CaptchaRequiredError)) throw error;
        const pasted = await this.prompt("GitCode requires 易盾/MFA. Paste the web access_token and press Enter: ");
        this.current = await this.loginWithPastedToken(pasted);
      }
      return this.current;
    }
    throw new AuthError("No CANNLab web access token or GitCode account/password is configured. Run `cannlabctl auth login`.");
  }

  async login(): Promise<TokenSet> {
    if (this.settings.accessToken) {
      await this.validate(this.settings.accessToken);
      const tokenSet: TokenSet = {
        accessToken: this.settings.accessToken,
        refreshToken: this.settings.refreshToken,
        persist: true,
        source: this.settings.accessTokenSource ?? "environment",
      };
      await this.persist(tokenSet);
      this.current = tokenSet;
      return tokenSet;
    }

    if (this.settings.dotenvAccessToken) {
      const tokenSet: TokenSet = {
        accessToken: this.settings.dotenvAccessToken,
        refreshToken: this.settings.dotenvRefreshToken,
        persist: true,
        source: "dotenv",
      };
      await this.validate(tokenSet.accessToken);
      await this.persist(tokenSet);
      this.current = tokenSet;
      return tokenSet;
    }

    if (this.settings.gitcodeAccount && this.settings.gitcodePassword) {
      try {
        const tokenSet = await this.loginWithCredentials(this.settings.gitcodeAccount, this.settings.gitcodePassword, true);
        this.current = tokenSet;
        return tokenSet;
      } catch (error) {
        if (!(error instanceof CaptchaRequiredError)) throw error;
        const pasted = await this.prompt("GitCode requires 易盾/MFA. Paste the web access_token and press Enter: ");
        return this.loginWithPastedToken(pasted);
      }
    }

    const pasted = await this.prompt("Paste the GitCode web access_token and press Enter: ");
    return this.loginWithPastedToken(pasted);
  }

  async status(): Promise<Record<string, unknown>> {
    const cache = await loadAuthCache(this.settings.authFile);
    if (this.settings.accessToken) {
      return { authenticated: true, source: this.settings.accessTokenSource ?? "environment", account: undefined, cached: Boolean(cache), cacheFile: this.settings.authFile };
    }
    if (cache) return { authenticated: true, source: "cache", account: cache.account, cached: true, cacheFile: this.settings.authFile };
    if (this.settings.dotenvAccessToken) {
      return { authenticated: true, source: "dotenv", account: undefined, cached: false, cacheFile: this.settings.authFile };
    }
    return { authenticated: false, source: undefined, account: undefined, cached: false, cacheFile: this.settings.authFile };
  }

  async refresh(): Promise<string | undefined> {
    const current = await this.resolve();
    if (!current.refreshToken) return undefined;
    const refreshed = await this.authClient.refresh(current.accessToken, current.refreshToken);
    const next: TokenSet = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      account: refreshed.account ?? current.account,
      accountInfo: refreshed.accountInfo ?? current.accountInfo,
      persist: current.persist,
      source: current.source,
    };
    if (next.persist) await this.persist(next);
    this.current = next;
    return next.accessToken;
  }

  get currentToken(): TokenSet | undefined {
    return this.current;
  }

  private async loginWithCredentials(account: string, password: string, persist: boolean): Promise<TokenSet> {
    const tokens = await this.authClient.loginWithPassword(account, password);
    const tokenSet = fromAuthTokens(tokens, "dotenv", persist, account);
    await this.validate(tokenSet.accessToken);
    if (persist) await this.persist(tokenSet);
    return tokenSet;
  }

  private async loginWithPastedToken(token: string): Promise<TokenSet> {
    const accessToken = token.trim();
    if (!accessToken) throw new AuthError("No access token was provided.");
    await this.validate(accessToken);
    const tokenSet: TokenSet = { accessToken, persist: true, source: "prompt" };
    await this.persist(tokenSet);
    this.current = tokenSet;
    return tokenSet;
  }

  private async validate(token: string): Promise<void> {
    if (this.options.validateToken) return this.options.validateToken(token);
    const url = new URL(`${this.settings.apiBase}/overview`);
    url.searchParams.set("type", "cann");
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${token}`,
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
          origin: "https://gitcode.com",
          referer: "https://gitcode.com/",
        },
      });
    } catch (error) {
      throw new AuthError(`CANNLab access token validation request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok || envelopeFailed(body)) {
      const message = extractMessage(body);
      throw new AuthError(`CANNLab access token validation failed (HTTP ${response.status})${message ? `: ${message}` : ""}`, { status: response.status, body: redact(summarizeBody(body ?? text)) });
    }
  }

  private async persist(tokenSet: TokenSet): Promise<void> {
    const cache: AuthCache = {
      access_token: tokenSet.accessToken,
      refresh_token: tokenSet.refreshToken,
      account: tokenSet.account,
      account_info: tokenSet.accountInfo,
    };
    // Keep only the documented token/account fields. In particular, never persist xauth_token or cookies.
    if (!cache.refresh_token) delete cache.refresh_token;
    if (!cache.account) delete cache.account;
    if (!cache.account_info || Object.keys(cache.account_info).length === 0) delete cache.account_info;
    await saveAuthCache(this.settings.authFile, cache);
  }
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function envelopeFailed(body: unknown): boolean {
  const objects: Record<string, unknown>[] = [];
  collectObjects(body, objects, new Set<unknown>());
  if (objects.some((object) => object.success === false || object.ok === false || hasMeaningfulErrorField(object, "error") || hasMeaningfulErrorField(object, "errors") || "error_message" in object || "errorMessage" in object)) return true;
  const code = firstCode(objects);
  if (code === undefined) return false;
  if (typeof code === "number") return code !== 0 && (code < 200 || code >= 300);
  const normalized = code.trim().toUpperCase();
  if (["0", "OK", "SUCCESS", "TRUE"].includes(normalized)) return false;
  const numeric = Number(normalized);
  return !(Number.isFinite(numeric) && numeric >= 200 && numeric < 300);
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

function firstCode(objects: Record<string, unknown>[]): string | number | undefined {
  for (const object of objects) {
    for (const key of ["error_code", "errorCode"]) {
      if (typeof object[key] === "string" || typeof object[key] === "number") return object[key] as string | number;
    }
  }
  for (const object of objects) {
    for (const key of ["code", "status_code", "statusCode"]) {
      if (typeof object[key] === "string" || typeof object[key] === "number") return object[key] as string | number;
    }
  }
  return undefined;
}

function collectObjects(value: unknown, result: Record<string, unknown>[], seen: Set<unknown>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectObjects(child, result, seen);
    return;
  }
  const object = value as Record<string, unknown>;
  result.push(object);
  for (const child of Object.values(object)) collectObjects(child, result, seen);
}

function summarizeBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function fromCache(cache: AuthCache): TokenSet {
  return { accessToken: cache.access_token, refreshToken: cache.refresh_token, account: cache.account, accountInfo: cache.account_info, persist: true, source: "cache" };
}

function fromAuthTokens(tokens: AuthTokens, source: TokenSet["source"], persist: boolean, fallbackAccount?: string): TokenSet {
  if (!tokens.accessToken) throw new AuthError("Authentication response did not contain an access token.");
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, account: tokens.account ?? fallbackAccount, accountInfo: tokens.accountInfo, persist, source };
}

async function defaultPrompt(message: string): Promise<string> {
  if (input.isTTY) {
    const rl = createInterface({ input, output });
    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  }
  output.write(`${message}\n`);
  let pasted = "";
  for await (const chunk of input) pasted += String(chunk);
  if (!pasted.trim()) throw new AuthError("Token input was empty. Set CANNLAB_ACCESS_TOKEN or run `cannlabctl auth login` with a token on standard input.");
  return pasted.trim();
}
