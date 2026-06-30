#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PLUGIN_ID = "homio.atlas-bridge";
const DEFAULT_BASE_URL = "https://paperclip.ai.k-digital.pro";
const DEFAULT_COMPANY_PREFIX = "HOM";
const DEFAULT_AGENT_NAME = "OpenClaw";
const DEFAULT_SYNC_REASON = "hmr_plugin_route_auth_proof";
const DEFAULT_REQUEST = "HMR plugin route auth proof. This request only proves Paperclip route auth reaches the installed plugin worker.";

function usage() {
  console.error(
    [
      "Usage:",
      "  node --import tsx scripts/hmr-plugin-route-auth-proof.mjs [options]",
      "",
      "Options:",
      "  --base-url <url>              Paperclip HMR base URL",
      "  --company-id <uuid>           Target company id",
      "  --company-prefix <prefix>     Target company issue prefix, default HOM",
      "  --agent-id <uuid>             Existing non-terminated agent id",
      "  --agent-name <name>           Existing non-terminated agent name, default OpenClaw",
      "  --plugin-id <id-or-key>       Plugin UUID or key, default homio.atlas-bridge",
      "  --issue-id <id>               Issue id/identifier for action probes",
      "  --sync-probe                  Probe atlas-bridge-sync-issue-projection",
      "  --launch-probe                Probe atlas-bridge-launch-issue-execution",
      "  --repo <repo>                 Launch repo param, default homio/core",
      "  --env-name <env>              Launch envName param, default ai01",
      "  --json                        Emit JSON only",
    ].join("\n"),
  );
}

export function parseArgs(argv) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    companyPrefix: DEFAULT_COMPANY_PREFIX,
    companyId: null,
    agentId: null,
    agentName: DEFAULT_AGENT_NAME,
    pluginId: DEFAULT_PLUGIN_ID,
    issueId: null,
    syncProbe: false,
    launchProbe: false,
    repo: "homio/core",
    envName: "ai01",
    request: DEFAULT_REQUEST,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "--base-url") out.baseUrl = readValue();
    else if (arg === "--company-id") out.companyId = readValue();
    else if (arg === "--company-prefix") out.companyPrefix = readValue();
    else if (arg === "--agent-id") out.agentId = readValue();
    else if (arg === "--agent-name") out.agentName = readValue();
    else if (arg === "--plugin-id") out.pluginId = readValue();
    else if (arg === "--issue-id") out.issueId = readValue();
    else if (arg === "--repo") out.repo = readValue();
    else if (arg === "--env-name") out.envName = readValue();
    else if (arg === "--request") out.request = readValue();
    else if (arg === "--sync-probe") out.syncProbe = true;
    else if (arg === "--launch-probe") out.launchProbe = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  const key = match[1];
  let value = match[2] ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

export function loadEnvFiles(paths) {
  const loaded = [];
  for (const envPath of paths) {
    if (!envPath || !existsSync(envPath)) continue;
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      if (process.env[parsed.key] === undefined) {
        process.env[parsed.key] = parsed.value;
      }
    }
    loaded.push(envPath);
  }
  return loaded;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function closeDb(db) {
  const candidate = db && typeof db === "object"
    ? db.$client ?? db.session?.client ?? null
    : null;
  if (!candidate || typeof candidate.end !== "function") return Promise.resolve();
  return candidate.end().catch(() => undefined);
}

async function importRuntimeModules(runtimeRoot) {
  const dbModule = await import(pathToFileURL(path.join(runtimeRoot, "server/node_modules/@paperclipai/db/src/index.ts")).href);
  const runtimeConfig = await import(pathToFileURL(path.join(runtimeRoot, "packages/db/src/runtime-config.ts")).href);
  const agentJwt = await import(pathToFileURL(path.join(runtimeRoot, "server/src/agent-auth-jwt.ts")).href);
  const drizzle = await import(pathToFileURL(path.join(runtimeRoot, "server/node_modules/drizzle-orm/index.js")).href);
  return { ...dbModule, ...runtimeConfig, ...agentJwt, ...drizzle };
}

async function resolveDatabaseUrl(resolveDatabaseTarget) {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") return target.connectionString;
  return `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;
}

async function resolveCompany(db, modules, opts) {
  const { companies, eq } = modules;
  const condition = opts.companyId
    ? eq(companies.id, opts.companyId)
    : eq(companies.issuePrefix, opts.companyPrefix);
  const row = await db.select().from(companies).where(condition).then((rows) => rows[0] ?? null);
  if (!row) {
    throw new Error(`Company not found for ${opts.companyId ? "id" : "prefix"} ${opts.companyId ?? opts.companyPrefix}`);
  }
  return row;
}

async function resolveAgent(db, modules, company, opts) {
  const { agents, and, eq } = modules;
  const condition = opts.agentId
    ? and(eq(agents.companyId, company.id), eq(agents.id, opts.agentId))
    : and(eq(agents.companyId, company.id), eq(agents.name, opts.agentName));
  const row = await db.select().from(agents).where(condition).then((rows) => rows[0] ?? null);
  if (!row) {
    throw new Error(`Agent not found in company ${company.issuePrefix}: ${opts.agentId ?? opts.agentName}`);
  }
  if (row.status === "terminated" || row.status === "pending_approval") {
    throw new Error(`Agent ${row.id} is not usable for proof because status=${row.status}`);
  }
  return row;
}

export function buildSyncActionBody(companyId, issueId) {
  return {
    companyId,
    params: {
      companyId,
      issueId,
      reason: DEFAULT_SYNC_REASON,
    },
  };
}

export function buildLaunchActionBody(companyId, issueId, opts = {}) {
  return {
    companyId,
    params: {
      companyId,
      issueId,
      repo: opts.repo ?? "homio/core",
      envName: opts.envName ?? "ai01",
      request: opts.request ?? DEFAULT_REQUEST,
    },
  };
}

export function summarizeHttpResult(status, bodyText) {
  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }
  const text = typeof bodyText === "string" ? bodyText.slice(0, 1000) : "";
  return {
    status,
    routeAuthOk: status !== 401 && status !== 403,
    body: parsed ?? text,
  };
}

async function requestJson({ method, url, token, runId, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": runId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return summarizeHttpResult(response.status, text);
}

function findPlugin(discovery, pluginId) {
  const rows = Array.isArray(discovery.body) ? discovery.body : [];
  return rows.find((row) => row?.id === pluginId || row?.pluginKey === pluginId) ?? null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runtimeRoot = process.env.PAPERCLIP_RUNTIME_ROOT || process.cwd();
  const envPaths = [
    process.env.PAPERCLIP_ENV_FILE,
    path.join(runtimeRoot, ".env"),
    "/workspace/.env",
    "/workspace/projects/paperclip-control-plane/.env",
  ];
  const loadedEnvFiles = loadEnvFiles(envPaths);
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip";
  }
  const modules = await importRuntimeModules(runtimeRoot);
  const databaseUrl = await resolveDatabaseUrl(modules.resolveDatabaseTarget);
  const db = modules.createDb(databaseUrl);
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const runId = randomUUID();

  try {
    const company = await resolveCompany(db, modules, opts);
    const agent = await resolveAgent(db, modules, company, opts);
    const token = modules.createLocalAgentJwt(agent.id, company.id, agent.adapterType, runId);
    if (!token) {
      throw new Error("Could not create local agent JWT. PAPERCLIP_AGENT_JWT_SECRET or BETTER_AUTH_SECRET is missing from the helper runtime.");
    }

    const discovery = await requestJson({
      method: "GET",
      url: `${baseUrl}/api/plugins?limit=100`,
      token,
      runId,
    });
    const plugin = findPlugin(discovery, opts.pluginId);
    const resolvedPluginId = plugin?.id ?? opts.pluginId;
    const actions = [];

    if ((opts.syncProbe || opts.launchProbe) && !opts.issueId) {
      throw new Error("--issue-id is required for action probes");
    }

    if (opts.syncProbe) {
      actions.push({
        key: "atlas-bridge-sync-issue-projection",
        result: await requestJson({
          method: "POST",
          url: `${baseUrl}/api/plugins/${resolvedPluginId}/actions/atlas-bridge-sync-issue-projection`,
          token,
          runId,
          body: buildSyncActionBody(company.id, opts.issueId),
        }),
      });
    }

    if (opts.launchProbe) {
      actions.push({
        key: "atlas-bridge-launch-issue-execution",
        result: await requestJson({
          method: "POST",
          url: `${baseUrl}/api/plugins/${resolvedPluginId}/actions/atlas-bridge-launch-issue-execution`,
          token,
          runId,
          body: buildLaunchActionBody(company.id, opts.issueId, opts),
        }),
      });
    }

    const report = {
      ok: discovery.routeAuthOk && actions.every((entry) => entry.result.routeAuthOk),
      credential: {
        type: "local_agent_jwt",
        token: "<redacted>",
        runId,
      },
      baseUrl,
      company: {
        id: company.id,
        issuePrefix: company.issuePrefix,
      },
      agent: {
        id: agent.id,
        name: agent.name,
        adapterType: agent.adapterType,
        status: agent.status,
      },
      loadedEnvFiles,
      discovery: {
        status: discovery.status,
        routeAuthOk: discovery.routeAuthOk,
        plugin: plugin
          ? {
              id: plugin.id,
              pluginKey: plugin.pluginKey,
              version: plugin.version,
              status: plugin.status,
            }
          : null,
      },
      actions,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 2;
  } finally {
    await closeDb(db);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
