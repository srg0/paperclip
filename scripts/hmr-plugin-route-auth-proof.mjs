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
      "  server/node_modules/.bin/tsx scripts/hmr-plugin-route-auth-proof.mjs [options]",
      "  pnpm --filter @paperclipai/server exec tsx ../scripts/hmr-plugin-route-auth-proof.mjs [options]",
      "  node --import tsx scripts/hmr-plugin-route-auth-proof.mjs [options]  # only when tsx is resolvable from the runtime root",
      "",
      "Options:",
      "  --base-url <url>              Paperclip HMR base URL",
      "  --company-id <uuid>           Target company id",
      "  --company-prefix <prefix>     Target company issue prefix, default HOM",
      "  --agent-id <uuid>             Existing non-terminated agent id",
      "  --agent-name <name>           Existing non-terminated agent name, default OpenClaw",
      "  --plugin-id <id-or-key>       Plugin UUID or key, default homio.atlas-bridge",
      "  --issue-id <id>               Issue id/identifier for action probes",
      "  --create-issue                Create or reuse one HMR proof issue through the public Paperclip route",
      "  --issue-title <title>         Title for --create-issue",
      "  --issue-description <body>    Description for --create-issue",
      "  --issue-status <status>       Status for --create-issue, default backlog",
      "  --issue-priority <priority>   Priority for --create-issue, default medium",
      "  --origin-kind <kind>          Origin kind for idempotent --create-issue lookup",
      "  --origin-id <id>              Origin id for idempotent --create-issue lookup",
      "  --project-id <uuid>           Optional project id for --create-issue",
      "  --assignee-agent-id <uuid>    Optional assignee agent id for --create-issue",
      "  --run-id <uuid>               Optional proof run id; default creates a new UUID",
      "  --skip-heartbeat-run          Do not insert a proof heartbeat run before route probes",
      "  --sync-probe                  Probe atlas-bridge-sync-issue-projection",
      "  --launch-probe                Probe atlas-bridge-launch-issue-execution",
      "  --followup-probe              Probe atlas-bridge-followup-issue-execution",
      "  --data-probe                  Probe atlas-bridge-issue-execution data projection",
      "  --data-key <key>              Plugin data key, default atlas-bridge-issue-execution",
      "  --repo <repo>                 Launch repo param, default homio/core",
      "  --env-name <env>              Launch envName param, default ai01",
      "  --branch <branch>             Optional follow-up branch/change identity",
      "  --current-atlas-task-id <id>  Optional currently bound Atlas task id for follow-up",
      "  --task-id <id>                Optional explicit follow-up Atlas task id",
      "  --turn-number <number>        Optional follow-up turn number",
      "  --turn-label <label>          Optional follow-up turn label",
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
    createIssue: false,
    issueTitle: "HMR plugin route auth proof issue",
    issueDescription: "HMR-only proof issue created by scripts/hmr-plugin-route-auth-proof.mjs.",
    issueStatus: "backlog",
    issuePriority: "medium",
    originKind: null,
    originId: null,
    projectId: null,
    assigneeAgentId: null,
    runId: null,
    skipHeartbeatRun: false,
    syncProbe: false,
    launchProbe: false,
    followupProbe: false,
    dataProbe: false,
    dataKey: "atlas-bridge-issue-execution",
    repo: "homio/core",
    envName: "ai01",
    branch: null,
    currentAtlasTaskId: null,
    taskId: null,
    turnNumber: null,
    turnLabel: null,
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
    else if (arg === "--create-issue") out.createIssue = true;
    else if (arg === "--issue-title") out.issueTitle = readValue();
    else if (arg === "--issue-description") out.issueDescription = readValue();
    else if (arg === "--issue-status") out.issueStatus = readValue();
    else if (arg === "--issue-priority") out.issuePriority = readValue();
    else if (arg === "--origin-kind") out.originKind = readValue();
    else if (arg === "--origin-id") out.originId = readValue();
    else if (arg === "--project-id") out.projectId = readValue();
    else if (arg === "--assignee-agent-id") out.assigneeAgentId = readValue();
    else if (arg === "--run-id") out.runId = readValue();
    else if (arg === "--skip-heartbeat-run") out.skipHeartbeatRun = true;
    else if (arg === "--repo") out.repo = readValue();
    else if (arg === "--env-name") out.envName = readValue();
    else if (arg === "--branch") out.branch = readValue();
    else if (arg === "--current-atlas-task-id") out.currentAtlasTaskId = readValue();
    else if (arg === "--task-id") out.taskId = readValue();
    else if (arg === "--turn-number") out.turnNumber = Number(readValue());
    else if (arg === "--turn-label") out.turnLabel = readValue();
    else if (arg === "--data-key") out.dataKey = readValue();
    else if (arg === "--request") out.request = readValue();
    else if (arg === "--sync-probe") out.syncProbe = true;
    else if (arg === "--launch-probe") out.launchProbe = true;
    else if (arg === "--followup-probe") out.followupProbe = true;
    else if (arg === "--data-probe") out.dataProbe = true;
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

export function buildProofHeartbeatRunRecord({ runId, companyId, agentId, now = new Date() }) {
  return {
    id: runId,
    companyId,
    agentId,
    invocationSource: "hmr_plugin_route_auth_proof",
    triggerDetail: "local_agent_jwt_route_proof",
    status: "succeeded",
    startedAt: now,
    finishedAt: now,
    resultJson: {
      proof: "hmr_plugin_route_auth",
      routeContext: "public_paperclip_api",
    },
  };
}

async function ensureProofHeartbeatRun(db, modules, { runId, company, agent }) {
  const { heartbeatRuns } = modules;
  const rows = await db
    .insert(heartbeatRuns)
    .values(buildProofHeartbeatRunRecord({ runId, companyId: company.id, agentId: agent.id }))
    .onConflictDoNothing()
    .returning({ id: heartbeatRuns.id });
  return {
    id: runId,
    created: rows.length > 0,
    status: "succeeded",
  };
}

export function buildSkippedHeartbeatRunRecord(runId) {
  return {
    id: runId,
    created: false,
    skipped: true,
    status: "skipped",
    reason: "skip_heartbeat_run",
  };
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

export function buildFollowupActionBody(companyId, issueId, opts = {}) {
  const params = {
    companyId,
    issueId,
    repo: opts.repo ?? "homio/core",
    envName: opts.envName ?? "ai01",
    request: opts.request ?? DEFAULT_REQUEST,
  };
  if (opts.branch) params.branch = opts.branch;
  if (opts.currentAtlasTaskId) params.currentAtlasTaskId = opts.currentAtlasTaskId;
  if (opts.taskId) params.taskId = opts.taskId;
  if (opts.turnNumber) params.turnNumber = opts.turnNumber;
  if (opts.turnLabel) params.turnLabel = opts.turnLabel;
  return {
    companyId,
    params,
  };
}

export function buildDataProbeBody(companyId, issueId) {
  return {
    companyId,
    params: {
      companyId,
      issueId,
    },
  };
}

export function buildCreateIssueBody(opts = {}) {
  const body = {
    title: opts.title ?? "HMR plugin route auth proof issue",
    description: opts.description ?? "HMR-only proof issue created by scripts/hmr-plugin-route-auth-proof.mjs.",
    status: opts.status ?? "backlog",
    priority: opts.priority ?? "medium",
  };
  if (opts.projectId) body.projectId = opts.projectId;
  if (opts.assigneeAgentId) body.assigneeAgentId = opts.assigneeAgentId;
  if (opts.originKind) body.originKind = opts.originKind;
  if (opts.originId) body.originId = opts.originId;
  return body;
}

export function buildIssueOriginLookupUrl(baseUrl, companyId, originKind, originId) {
  const params = new URLSearchParams({
    originKind,
    originId,
    limit: "10",
  });
  return `${baseUrl}/api/companies/${encodeURIComponent(companyId)}/issues?${params.toString()}`;
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
    transportOk: true,
    routeAuthOk: status !== 401 && status !== 403,
    body: parsed ?? text,
  };
}

export function summarizeFetchError(error, url) {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  const cause = error instanceof Error && error.cause
    ? {
        name: error.cause?.name,
        code: error.cause?.code,
        message: error.cause?.message,
      }
    : null;
  return {
    status: null,
    transportOk: false,
    routeAuthOk: null,
    body: null,
    error: {
      name,
      message,
      cause,
      url,
    },
  };
}

function hasRouteAuth(result) {
  return result?.routeAuthOk === true;
}

function isHttpSuccess(result) {
  return result && result.status >= 200 && result.status < 300;
}

async function requestJson({ method, url, token, runId, body }) {
  try {
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
  } catch (error) {
    return summarizeFetchError(error, url);
  }
}

async function findExistingIssueByOrigin({ baseUrl, companyId, token, runId, originKind, originId }) {
  if (!originKind || !originId) return null;
  const result = await requestJson({
    method: "GET",
    url: buildIssueOriginLookupUrl(baseUrl, companyId, originKind, originId),
    token,
    runId,
  });
  if (!result.routeAuthOk || !isHttpSuccess(result)) {
    return {
      lookup: result,
      issue: null,
    };
  }
  const rows = Array.isArray(result.body) ? result.body : [];
  return {
    lookup: result,
    issue: rows[0] ?? null,
  };
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
  const runId = opts.runId ?? randomUUID();

  try {
    const company = await resolveCompany(db, modules, opts);
    const agent = await resolveAgent(db, modules, company, opts);
    const heartbeatRun = opts.skipHeartbeatRun
      ? buildSkippedHeartbeatRunRecord(runId)
      : await ensureProofHeartbeatRun(db, modules, { runId, company, agent });
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
    let issueCreate = null;

    if ((opts.syncProbe || opts.launchProbe || opts.followupProbe || opts.dataProbe) && !opts.issueId) {
      throw new Error("--issue-id is required for action/data probes");
    }

    if (opts.createIssue) {
      const existing = await findExistingIssueByOrigin({
        baseUrl,
        companyId: company.id,
        token,
        runId,
        originKind: opts.originKind,
        originId: opts.originId,
      });

      if (existing?.issue) {
        issueCreate = {
          duplicateHandling: "reused_existing_origin_issue",
          lookup: existing.lookup,
          issue: existing.issue,
          create: null,
        };
      } else if (existing?.lookup && !isHttpSuccess(existing.lookup)) {
        issueCreate = {
          duplicateHandling: "origin_lookup_failed_no_create",
          lookup: existing.lookup,
          issue: null,
          create: null,
        };
      } else {
        const createBody = buildCreateIssueBody({
          title: opts.issueTitle,
          description: opts.issueDescription,
          status: opts.issueStatus,
          priority: opts.issuePriority,
          originKind: opts.originKind,
          originId: opts.originId,
          projectId: opts.projectId,
          assigneeAgentId: opts.assigneeAgentId,
        });
        const createResult = await requestJson({
          method: "POST",
          url: `${baseUrl}/api/companies/${encodeURIComponent(company.id)}/issues`,
          token,
          runId,
          body: createBody,
        });
        issueCreate = {
          duplicateHandling: opts.originKind && opts.originId ? "created_after_empty_origin_lookup" : "not_origin_scoped",
          lookup: existing?.lookup ?? null,
          issue: createResult.body ?? null,
          create: createResult,
        };
      }
    }

    const issueCreateOk = !issueCreate || Boolean(
      issueCreate.issue && (!issueCreate.create || isHttpSuccess(issueCreate.create)),
    );

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

    if (opts.followupProbe) {
      actions.push({
        key: "atlas-bridge-followup-issue-execution",
        result: await requestJson({
          method: "POST",
          url: `${baseUrl}/api/plugins/${resolvedPluginId}/actions/atlas-bridge-followup-issue-execution`,
          token,
          runId,
          body: buildFollowupActionBody(company.id, opts.issueId, opts),
        }),
      });
    }

    const dataProbes = [];
    if (opts.dataProbe) {
      dataProbes.push({
        key: opts.dataKey,
        result: await requestJson({
          method: "POST",
          url: `${baseUrl}/api/plugins/${resolvedPluginId}/data/${encodeURIComponent(opts.dataKey)}`,
          token,
          runId,
          body: buildDataProbeBody(company.id, opts.issueId),
        }),
      });
    }

    const report = {
      ok: hasRouteAuth(discovery) &&
        actions.every((entry) => hasRouteAuth(entry.result)) &&
        dataProbes.every((entry) => hasRouteAuth(entry.result)) &&
        issueCreateOk,
      credential: {
        type: "local_agent_jwt",
        token: "<redacted>",
        runId,
      },
      heartbeatRun,
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
      issueCreate,
      actions,
      dataProbes,
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
