import type { ApiErrorDetails } from "./types.js";

const SECRET_KEY = /(pass(word)?|token|secret|cookie|authorization|xauth|private[_-]?key|access[_-]?token|refresh[_-]?token)/i;
const SECRET_TEXT = /(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi;
const LABELED_SECRET_TEXT = /((?:access[_-]?token|refresh[_-]?token|password|passwd|cookie|xauth[_-]?token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

export class CliError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code = "CLI_ERROR", details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

export class ApiError extends CliError {
  readonly api: ApiErrorDetails;

  constructor(api: ApiErrorDetails) {
    super(api.errorMessage, "API_ERROR", api);
    this.name = "ApiError";
    this.api = api;
  }
}

export class AuthError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, "AUTH_ERROR", details);
    this.name = "AuthError";
  }
}

export class CaptchaRequiredError extends AuthError {
  constructor(message = "GitCode requires an interactive captcha or MFA verification.") {
    super(message, { requiresInteractiveToken: true });
    this.name = "CaptchaRequiredError";
  }
}

export class ConfirmationRequiredError extends CliError {
  constructor(message: string) {
    super(message, "CONFIRMATION_REQUIRED");
    this.name = "ConfirmationRequiredError";
  }
}

export class PollTimeoutError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, "POLL_TIMEOUT", details);
    this.name = "PollTimeoutError";
  }
}

export function redact(value: unknown, keyHint?: string): unknown {
  if (keyHint && SECRET_KEY.test(keyHint)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[key] = redact(child, key);
    return result;
  }
  return value;
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return {
      error: {
        code: error.code,
        message: redactText(error.message),
        status: error.api.status,
        error_code: error.api.errorCode,
        error_code_name: error.api.errorCodeName,
        trace_id: error.api.traceId,
        ambiguous: error.api.ambiguous ?? false,
      },
    };
  }
  if (error instanceof CliError) return { error: { code: error.code, message: redactText(error.message), details: redact(error.details) } };
  if (error instanceof Error) return { error: { code: "UNEXPECTED_ERROR", message: redactText(error.message) } };
  return { error: { code: "UNEXPECTED_ERROR", message: redactText(String(error)) } };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const parts = [`${error.api.status} ${redactText(error.message)}`];
    if (error.api.errorCodeName) parts.push(`code=${error.api.errorCodeName}`);
    else if (error.api.errorCode !== undefined) parts.push(`code=${error.api.errorCode}`);
    if (error.api.traceId) parts.push(`trace=${error.api.traceId}`);
    if (error.api.ambiguous) parts.push("the remote operation may have been accepted; inspect the environment before retrying");
    return parts.join("; ");
  }
  return error instanceof Error ? redactText(error.message) : redactText(String(error));
}

function redactText(value: string): string {
  return value.replace(SECRET_TEXT, "$1[REDACTED]").replace(LABELED_SECRET_TEXT, "$1[REDACTED]");
}
