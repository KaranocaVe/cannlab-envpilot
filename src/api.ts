import { ApiError, CliError, redact } from "./errors.js";
import { sleep } from "./utils.js";
import type { ApiErrorDetails, CreateEnvironmentPayload } from "./types.js";

export interface AuthProvider {
  resolve(): Promise<{ accessToken: string }>;
  refresh(): Promise<string | undefined>;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  auth?: AuthProvider;
  maxGetAttempts?: number;
  retryBaseMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  defaultHeaders?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class CannlabApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly auth?: AuthProvider;
  private readonly maxGetAttempts: number;
  private readonly retryBaseMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly defaultHeaders: Record<string, string>;
  private readonly requestTimeoutMs: number;

  constructor(private readonly baseUrl: string, options: ApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.auth = options.auth;
    this.maxGetAttempts = Math.max(1, options.maxGetAttempts ?? 3);
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.defaultHeaders = options.defaultHeaders ?? {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      origin: "https://gitcode.com",
      referer: "https://gitcode.com/",
    };
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 60_000);
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const retryable = method === "GET";
    let accessToken: string | undefined;
    let refreshed = false;
    let attempt = 0;

    while (attempt < (retryable ? this.maxGetAttempts : 1)) {
      attempt += 1;
      try {
        accessToken ??= this.auth ? (await this.auth.resolve()).accessToken : undefined;
        const request = makeRequestSignal(options.signal, this.requestTimeoutMs);
        try {
          const response = await this.fetchImpl(this.buildUrl(path, options.query), {
            method,
            headers: {
              accept: "application/json",
              ...this.defaultHeaders,
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
              ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
              ...options.headers,
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: request.signal,
          });
          const body = await parseResponseBody(response);
          const error = toApiError(response.status, body);
          if (error) {
            // A mutation must never be replayed: a 401 can arrive after the
            // server accepted the operation, so refresh only for safe GETs.
            if (retryable && !refreshed && this.auth && isTokenFailure(error)) {
              const nextToken = await this.auth.refresh();
              if (nextToken) {
                accessToken = nextToken;
                refreshed = true;
                attempt -= 1;
                continue;
              }
            }
            if (retryable && shouldRetryStatus(error.status) && attempt < this.maxGetAttempts) {
              await this.sleepImpl(backoff(this.retryBaseMs, attempt, response.headers.get("retry-after")));
              continue;
            }
            throw new ApiError({ ...error, ambiguous: method !== "GET" && error.status === 0 });
          }
          return body as T;
        } finally {
          request.dispose();
        }
      } catch (error) {
        if (error instanceof ApiError || error instanceof CliError) throw error;
        if (options.signal?.aborted) throw error;
        if (retryable && attempt < this.maxGetAttempts) {
          await this.sleepImpl(backoff(this.retryBaseMs, attempt));
          continue;
        }
        throw new ApiError({ status: 0, errorMessage: error instanceof Error ? error.message : String(error), ambiguous: method !== "GET" });
      }
    }
    throw new ApiError({ status: 0, errorMessage: "Request retry budget exhausted" });
  }

  getOverview(): Promise<unknown> {
    return this.request("/overview", { query: { type: "cann" } });
  }

  getResources(page = 1, perPage = 100): Promise<unknown> {
    return this.request("/resources", { query: { type: "cann", page, per_page: perPage } });
  }

  getResource(instanceKey: string, idType: "instance" | "pair" = "instance"): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}`, { query: { type: "cann", ...(idType === "pair" ? { id_type: "pair" } : {}) } });
  }

  getCreateAccess(): Promise<unknown> {
    return this.request("/resources/create-access", { query: { type: "cann" } });
  }

  getCreateGoods(): Promise<unknown> {
    return this.request("/resources/create-goods", { query: { type: "cann" } });
  }

  getCreateConfig(goodsCode?: string, specCode?: string): Promise<unknown> {
    return this.request("/resources/create-config", { query: { type: "cann", goods_code: goodsCode, spec_code: specCode } });
  }

  createEnvironment(payload: CreateEnvironmentPayload): Promise<unknown> {
    return this.request("/resources", { method: "POST", body: payload });
  }

  start(instanceKey: string): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}/start`, { method: "POST", query: { type: "cann" } });
  }

  stop(instanceKey: string): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}/stop`, { method: "POST", query: { type: "cann" } });
  }

  delete(instanceKeyOrPairId: string, idType: "instance" | "pair" = "instance"): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKeyOrPairId)}`, { method: "DELETE", query: { type: "cann", ...(idType === "pair" ? { id_type: "pair" } : {}) } });
  }

  getScripts(instanceKey: string): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}/scripts`, { query: { type: "cann" } });
  }

  getUpgrade(instanceKey: string): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}/upgrade`, { query: { type: "cann" } });
  }

  upgrade(instanceKey: string, scriptId: string, targetVersion: string): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}/upgrade`, {
      method: "POST",
      query: { type: "cann" },
      body: { script_id: scriptId, target_version: targetVersion },
    });
  }

  getGitSshKey(instanceKey: string): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}/git-ssh-key`, { method: "POST", query: { type: "cann" }, body: {} });
  }

  getGitToken(instanceKey: string): Promise<unknown> {
    return this.request(`/resources/${encodeURIComponent(instanceKey)}/git-token`, { method: "POST", query: { type: "cann" } });
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.replace(/^\/+/, ""), `${this.baseUrl.replace(/\/+$/, "")}/`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toApiError(status: number, body: unknown): ApiErrorDetails | undefined {
  const objects: ErrorObject[] = [];
  collectErrorObjects(body, objects, new Set<unknown>());
  const root = objects[0]?.value;
  const errorObjects = objects.filter(({ value, errorContext }) => errorContext || value.success === false || value.ok === false);
  const errorValues = errorObjects.map(({ value }) => value);
  const allValues = objects.map(({ value }) => value);
  const rootCode = root ? firstValue([root], ["code"]) : undefined;
  const code = firstValue(errorValues, ["error_code", "errorCode"]) ??
    firstValue(errorValues, ["code"]) ??
    (status >= 400 ? firstValue(allValues, ["code"]) : undefined) ?? rootCode;
  const codeName = firstString(errorValues.length ? errorValues : allValues, ["error_code_name", "errorCodeName", "code_name", "codeName"]);
  const message = firstString(errorValues.length ? errorValues : allValues, ["error_message", "errorMessage", "message", "msg", "detail"]);
  const failedFlag = objects.some(({ value }) => value.success === false || value.ok === false);
  const hasErrorObject = objects.some(({ value }) => hasMeaningfulErrorField(value, "error") || hasMeaningfulErrorField(value, "errors"));
  const nonZeroCode = code !== undefined && !isSuccessCode(code);
  const hasError = Boolean(hasErrorObject || errorObjects.length || failedFlag || nonZeroCode || status >= 400);
  if (!hasError) return undefined;
  const errorMessage = message ?? (typeof body === "string" ? summarizeText(body) : `CANNLab request failed with HTTP ${status}`);
  const traceId = firstString(errorValues.length ? errorValues : allValues, ["trace_id", "traceId", "request_id", "requestId"]);
  return { status, errorCode: code, errorCodeName: codeName, errorMessage: String(redact(errorMessage)), traceId, body: redact(summarizeBody(body)) };
}

function isTokenFailure(error: ApiErrorDetails): boolean {
  if (error.status === 401) return true;
  const message = `${error.errorCodeName ?? ""} ${error.errorMessage}`;
  return /(token|auth|credential|unauthorized|forbidden)/i.test(message) || /(?:token|auth).{0,24}invalid|invalid.{0,24}(?:token|auth)/i.test(message);
}

function isSuccessCode(value: string | number): boolean {
  if (typeof value === "number") return value === 0 || (value >= 200 && value < 300);
  const normalized = value.trim().toUpperCase();
  if (["0", "OK", "SUCCESS", "TRUE"].includes(normalized)) return true;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric >= 200 && numeric < 300;
}

function shouldRetryStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoff(base: number, attempt: number, retryAfter?: string | null): number {
  const retrySeconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(retrySeconds) && retrySeconds >= 0) return Math.min(10_000, retrySeconds * 1000);
  return Math.min(10_000, base * 2 ** Math.max(0, attempt - 1));
}

function firstString(objects: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const candidate of objects) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function firstValue(objects: Record<string, unknown>[], keys: string[]): string | number | undefined {
  for (const candidate of objects) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "string" || typeof value === "number") return value;
    }
  }
  return undefined;
}

interface ErrorObject {
  value: Record<string, unknown>;
  errorContext: boolean;
}

function collectErrorObjects(value: unknown, result: ErrorObject[], seen: Set<unknown>, errorContext = false): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectErrorObjects(child, result, seen, errorContext);
    return;
  }
  const object = value as Record<string, unknown>;
  const ownErrorFields = ["error_code", "errorCode", "error_code_name", "errorCodeName", "error_message", "errorMessage"].some((key) => key in object);
  const currentErrorContext = errorContext || ownErrorFields;
  result.push({ value: object, errorContext: currentErrorContext });
  for (const [key, child] of Object.entries(object)) {
    collectErrorObjects(child, result, seen, currentErrorContext || ((key === "error" || key === "errors") && isMeaningfulErrorValue(child)));
  }
}

function hasMeaningfulErrorField(object: Record<string, unknown>, key: "error" | "errors"): boolean {
  return key in object && isMeaningfulErrorValue(object[key]);
}

function isMeaningfulErrorValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function summarizeBody(value: unknown): unknown {
  return typeof value === "string" ? summarizeText(value) : value;
}

function summarizeText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function makeRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
  const abort = () => controller.abort(parent?.reason ?? new Error("Aborted"));
  if (parent) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}
