import { AuthManager } from "./auth-manager.js";
import { CannlabApiClient } from "./api.js";
import { resolveSettings, type Settings } from "./config.js";
import type { RuntimeOptions } from "./types.js";

export interface Runtime {
  settings: Settings;
  auth: AuthManager;
  api: CannlabApiClient;
}

export function createRuntime(options: RuntimeOptions = {}, dependencies: { fetchImpl?: typeof fetch } = {}): Runtime {
  const settings = resolveSettings(options);
  const auth = new AuthManager(settings, { fetchImpl: dependencies.fetchImpl });
  const api = new CannlabApiClient(settings.apiBase, { auth, fetchImpl: dependencies.fetchImpl });
  return { settings, auth, api };
}
