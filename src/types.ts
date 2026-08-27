export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  account?: string;
  accountInfo?: Record<string, unknown>;
  persist: boolean;
  source: "cli" | "environment" | "cache" | "dotenv" | "prompt";
}

export interface AuthCache {
  access_token: string;
  refresh_token?: string;
  account?: string;
  account_info?: Record<string, unknown>;
}

export interface ApiErrorDetails {
  status: number;
  errorCode?: string | number;
  errorCodeName?: string;
  errorMessage: string;
  traceId?: string;
  body?: unknown;
  ambiguous?: boolean;
}

export interface ResourceSummary {
  instanceKey: string;
  pairId?: string;
  name?: string;
  type?: string;
  status?: string;
  statusRaw?: string;
  createdAt?: string;
  updatedAt?: string;
  raw: unknown;
}

export interface CatalogOption {
  code: string;
  name?: string;
  type?: string;
  version?: string;
  goodsCode?: string;
  specCode?: string;
  templateCode?: string;
  templateSpecCode?: string;
  imageCode?: string;
  raw: unknown;
}

export interface CatalogSnapshot {
  goods: CatalogOption[];
  specs: CatalogOption[];
  templates: CatalogOption[];
  templateSpecs: CatalogOption[];
  images: CatalogOption[];
  raw: {
    access: unknown;
    goods: unknown;
    config?: unknown;
  };
}

export interface CreateEnvironmentPayload {
  goods_code: string;
  spec_code: string;
  instance_name: string;
  template_code: string;
  template_spec_code: string;
  image_code: string;
  template_name?: string;
  template_spec_name?: string;
  image_name?: string;
  cann_version?: string;
  repo_path?: string;
  repo_url?: string;
  repo_name?: string;
  repo_lang?: string;
  repo_branch?: string;
}

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  wait: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface RuntimeOptions {
  apiBase?: string;
  accessToken?: string;
  refreshToken?: string;
  envFile?: string;
  authFile?: string;
  timeout?: string | number;
  interval?: string | number;
  wait?: boolean;
  json?: boolean;
}
