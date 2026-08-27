import { Command, InvalidArgumentError } from "commander";

import { parseCatalog } from "./catalog.js";
import { resolveSettings } from "./config.js";
import { confirmDestructive } from "./confirm.js";
import { writeCredentialResponse } from "./credentials.js";
import { errorMessage, redact } from "./errors.js";
import { EnvironmentService } from "./environment.js";
import { createRuntime } from "./runtime.js";
import { extractResourceList, normalizeResource } from "./resources.js";
import { formatTable, jsonString } from "./utils.js";
import type { RuntimeOptions } from "./types.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("cannlabctl")
    .description("Inspect and manage CANNLab environments")
    .version("0.1.0")
    .option("--api-base <url>", "CANNLab API base URL")
    .option("--access-token <token>", "GitCode web access token")
    .option("--refresh-token <token>", "GitCode web refresh token")
    .option("--env-file <path>", "dotenv file to read")
    .option("--auth-file <path>", "local auth cache path")
    .option("--timeout <duration>", "poll timeout, e.g. 1800, 30m")
    .option("--interval <duration>", "poll interval, e.g. 5, 500ms")
    .option("--no-wait", "return after submitting a remote operation")
    .option("--json", "emit machine-readable JSON")
    .showSuggestionAfterError();

  const auth = program.command("auth").description("Manage CANNLab authentication");
  const login = auth.command("login").description("Authenticate with a web access token or GitCode account/password");
  addJson(login).action(async (_options, command) => {
    const runtime = createRuntime(runtimeOptions(command));
    const token = await runtime.auth.login();
    emit(command, { authenticated: true, source: token.source, account: token.account, cache_file: runtime.settings.authFile }, () => `Authenticated${token.account ? ` as ${token.account}` : ""}. Token cache: ${runtime.settings.authFile}`);
  });
  const status = auth.command("status").description("Show local authentication status");
  addJson(status).action(async (_options, command) => {
    const runtime = createRuntime(runtimeOptions(command));
    const result = await runtime.auth.status();
    emit(command, result, () => renderKeyValue(result));
  });
  const logout = auth.command("logout").description("Remove the local token cache").option("--yes", "confirm logout");
  addJson(logout).action(async (_options, command) => {
    const options = command.optsWithGlobals() as Record<string, unknown>;
    await confirmDestructive("Remove the local CANNLab token cache?", Boolean(options.yes));
    const runtime = createRuntime(runtimeOptions(command));
    const { clearAuthCache } = await import("./auth-store.js");
    const removed = await clearAuthCache(runtime.settings.authFile);
    emit(command, { logged_out: true, removed, cache_file: runtime.settings.authFile }, () => removed ? `Removed ${runtime.settings.authFile}` : "No local token cache was present.");
  });

  const overview = program.command("overview").description("Show CANNLab account/resource overview");
  addJson(overview).action(async (_options, command) => {
    const runtime = createRuntime(runtimeOptions(command));
    const body = await runtime.api.getOverview();
    emit(command, body, () => renderOverview(body));
  });

  const catalog = program.command("catalog").description("Inspect the dynamic create catalog");
  const catalogList = catalog.command("list").description("List current goods, specs, templates, and images");
  addJson(catalogList).action(async (_options, command) => {
    const snapshot = await serviceFor(command).catalog();
    emit(command, { goods: snapshot.goods, specs: snapshot.specs, templates: snapshot.templates, template_specs: snapshot.templateSpecs, images: snapshot.images, raw: snapshot.raw }, () => renderCatalog(snapshot));
  });

  const env = program.command("env").description("Manage CANNLab environments");
  const list = env.command("list").description("List environments");
  addJson(list).action(async (_options, command) => {
    const service = serviceFor(command);
    const result = await service.list();
    emit(command, { resources: result.resources, raw: result.raw }, () => formatTable(result.resources.map((resource) => ({ key: resource.instanceKey, pair: resource.pairId ?? "", name: resource.name ?? "", type: resource.type ?? "", status: resource.status ?? resource.statusRaw ?? "" })), ["key", "pair", "name", "type", "status"]));
  });

  const show = env.command("show <instanceKey>").description("Show one environment");
  addJson(show).action(async (instanceKey: string, _options, command) => {
    const service = serviceFor(command);
    const result = await service.show(instanceKey);
    emit(command, result, () => renderResource(result.resource, result.raw));
  });

  const create = env.command("create").description("Create an environment from the live catalog")
    .requiredOption("--type <type>", "hardware type: a2, a3, or cpu", parseType)
    .requiredOption("--name <name>", "instance name")
    .requiredOption("--template <code-or-name>", "template code or name")
    .requiredOption("--spec <code-or-name>", "template specification code or name (machine type is selected by --type)")
    .option("--image <code-or-name>", "optional image code or name")
    .option("--repo-path <path>")
    .option("--repo-url <url>")
    .option("--repo-name <name>")
    .option("--repo-lang <language>")
    .option("--repo-branch <branch>");
  addJson(create).action(async (_options, command) => {
    const options = command.optsWithGlobals() as Record<string, unknown>;
    const service = serviceFor(command);
    const result = await service.create({
      type: String(options.type),
      name: String(options.name),
      template: String(options.template),
      spec: String(options.spec),
      image: stringOption(options.image),
      repo: compactObject({ repo_path: options.repoPath, repo_url: options.repoUrl, repo_name: options.repoName, repo_lang: options.repoLang, repo_branch: options.repoBranch }),
    });
    emit(command, result, () => `Created ${result.resource?.instanceKey ?? "an environment"}${result.resource?.status ? ` (${result.resource.status})` : ""}.`);
  });

  const start = env.command("start <instanceKey>").description("Start an environment");
  addJson(start).action(async (instanceKey: string, _options, command) => {
    const result = await serviceFor(command).start(instanceKey);
    emit(command, result, () => renderResource(normalizeResource(result), result));
  });
  const stop = env.command("stop <instanceKey>").description("Stop an environment");
  addJson(stop).action(async (instanceKey: string, _options, command) => {
    const result = await serviceFor(command).stop(instanceKey);
    emit(command, result, () => renderResource(normalizeResource(result), result));
  });
  const del = env.command("delete <id>").description("Delete an environment or pair")
    .option("--id-type <type>", "interpret id as instance or pair", parseIdType, "instance")
    .option("--yes", "skip the deletion confirmation");
  addJson(del).action(async (id: string, _options, command) => {
    const options = command.optsWithGlobals() as Record<string, unknown>;
    await confirmDestructive("Deleting an environment permanently removes its /home and /mnt/workspace data.", Boolean(options.yes));
    const result = await serviceFor(command).delete(id, String(options.idType) as "instance" | "pair");
    emit(command, { deleted: true, id, id_type: options.idType, result }, () => `Deletion submitted and confirmed for ${id}.`);
  });
  const upgrade = env.command("upgrade <instanceKey>").description("Upgrade CANN using UPDATE_CANN_VERSION")
    .option("--version <version>", "target CANN version");
  addJson(upgrade).action(async (instanceKey: string, _options, command) => {
    const options = command.optsWithGlobals() as Record<string, unknown>;
    const result = await serviceFor(command).upgrade(instanceKey, stringOption(options.version));
    emit(command, result, () => `Upgrade submitted for ${instanceKey}.`);
  });

  addCredentialCommand(env, "git-ssh-key", "Fetch the environment Git SSH credential", "getGitSshKey");
  addCredentialCommand(env, "git-token", "Fetch the environment Git token", "getGitToken");
  return program;
}

function addCredentialCommand(env: Command, name: string, description: string, method: "getGitSshKey" | "getGitToken"): void {
  const command = env.command(`${name} <instanceKey>`).description(description).requiredOption("--out <file>", "0600 JSON output file").option("--force", "allow replacing the output file");
  addJson(command).action(async (instanceKey: string, _options, actionCommand) => {
    const options = actionCommand.optsWithGlobals() as Record<string, unknown>;
    const runtime = createRuntime(runtimeOptions(actionCommand));
    const response = await runtime.api[method](instanceKey);
    const result = await writeCredentialResponse(String(options.out), response, Boolean(options.force));
    emit(actionCommand, result, () => `Credential written to ${result.path} with mode 0600.`);
  });
}

function serviceFor(command: Command): EnvironmentService {
  const runtime = createRuntime(runtimeOptions(command));
  return new EnvironmentService({
    api: runtime.api,
    poll: { wait: runtime.settings.wait, intervalMs: runtime.settings.pollIntervalMs, timeoutMs: runtime.settings.timeoutMs },
    progress: runtime.settings.json ? undefined : (message) => process.stderr.write(`[cannlab] ${message}\n`),
  });
}

function runtimeOptions(command: Command): RuntimeOptions {
  const options = command.optsWithGlobals() as Record<string, unknown>;
  return {
    apiBase: stringOption(options.apiBase),
    accessToken: stringOption(options.accessToken),
    refreshToken: stringOption(options.refreshToken),
    envFile: stringOption(options.envFile),
    authFile: stringOption(options.authFile),
    timeout: stringOption(options.timeout),
    interval: stringOption(options.interval),
    wait: options.wait === undefined ? true : Boolean(options.wait),
    json: Boolean(options.json),
  };
}

function addJson(command: Command): Command {
  return command.option("--json", "emit machine-readable JSON");
}

function emit(command: Command, value: unknown, human: () => string): void {
  const options = command.optsWithGlobals() as Record<string, unknown>;
  if (Boolean(options.json)) process.stdout.write(`${jsonString(redact(value))}\n`);
  else process.stdout.write(`${human()}\n`);
}

function renderResource(resource: ReturnType<typeof normalizeResource>, raw: unknown): string {
  if (resource) return formatTable([{
    key: resource.instanceKey,
    pair: resource.pairId ?? "",
    name: resource.name ?? "",
    type: resource.type ?? "",
    status: resource.status ?? resource.statusRaw ?? "",
  }], ["key", "pair", "name", "type", "status"]);
  return renderKeyValue(raw);
}

function renderOverview(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) return renderKeyValue(value);
  return String(value ?? "(empty)");
}

function renderCatalog(snapshot: ReturnType<typeof parseCatalog>): string {
  const sections: string[] = [];
  for (const [label, items] of [["goods", snapshot.goods], ["specs", snapshot.specs], ["templates", snapshot.templates], ["template specs", snapshot.templateSpecs], ["images", snapshot.images]] as const) {
    sections.push(`${label}:\n${formatTable(items.map((item) => ({ code: item.code, name: item.name ?? "", type: item.type ?? "", version: item.version ?? "" })), ["code", "name", "type", "version"])}`);
  }
  return sections.join("\n\n");
}

function renderKeyValue(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "(empty)");
  return Object.entries(value as Record<string, unknown>).map(([key, child]) => `${key}: ${typeof child === "object" ? JSON.stringify(child) : String(child ?? "")}`).join("\n");
}

function compactObject(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => typeof child === "string" && child.trim()).map(([key, child]) => [key, String(child)]));
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseType(value: string): string {
  const normalized = value.toLowerCase();
  if (!["a2", "a3", "cpu"].includes(normalized)) throw new InvalidArgumentError("type must be a2, a3, or cpu");
  return normalized;
}

function parseIdType(value: string): string {
  if (!["instance", "pair"].includes(value)) throw new InvalidArgumentError("id-type must be instance or pair");
  return value;
}
