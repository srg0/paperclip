#!/usr/bin/env node

import crypto from "node:crypto";

import { collectSyntheticGroups, hasFlag, readArg, runRemoteNode, runSshCommand } from "./lib/incident-contour-ops.mjs";

const argv = process.argv;
const host = readArg(argv, "--host", "dev-cnt-pcl01");
const container = readArg(argv, "--container", "docker-paperclip-1");
const companyId = readArg(argv, "--company-id", "5f7311ad-c84a-4c17-96ba-b3744e2e2401");
const projectId = readArg(argv, "--project-id", "2e901644-af0a-4d25-84bf-6b15d1ebd65c");
const monitorAgentId = readArg(argv, "--monitor-agent-id", "4b77eabf-bf69-453c-8e78-d7ab1fe08ca1");
const maxMonitorAgeSec = Number(readArg(argv, "--max-monitor-age-sec", "900"));
const fingerprintFilter = readArg(argv, "--fingerprint", null);
const failOnViolations = hasFlag(argv, "--fail-on-violations");
const failOnHistorical = hasFlag(argv, "--fail-on-historical");
const summaryMode = hasFlag(argv, "--summary");

const remoteScript = `
const { Client } = require("/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg");

async function main() {
  const client = new Client({ connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip" });
  await client.connect();
  try {
    const companyId = ${JSON.stringify(companyId)};
    const projectId = ${JSON.stringify(projectId)};
    const monitorAgentId = ${JSON.stringify(monitorAgentId)};
    const maxMonitorAgeSec = ${JSON.stringify(maxMonitorAgeSec)};

    const nowRes = await client.query("select now() as now");
    const agentsRes = await client.query(
      "select id, name, status, pause_reason, adapter_type, created_at, updated_at, last_heartbeat_at from agents where company_id = $1 order by updated_at desc",
      [companyId],
    );
    const runsRes = await client.query(
      "select id, agent_id, status, invocation_source, created_at, started_at, finished_at, error_code, trigger_detail from heartbeat_runs where company_id = $1 order by created_at desc limit 200",
      [companyId],
    );
    const issuesRes = await client.query(
      "select id, issue_number, identifier, title, status, assignee_agent_id, execution_run_id, updated_at from issues where company_id = $1 and project_id = $2 order by issue_number desc limit 300",
      [companyId, projectId],
    );
    const docsRes = await client.query(
      "select i.identifier, i.title, i.status, idoc.key, d.latest_body from issue_documents idoc join issues i on i.id = idoc.issue_id join documents d on d.id = idoc.document_id where i.company_id = $1 and i.project_id = $2",
      [companyId, projectId],
    );
    const commentsRes = await client.query(
      "select i.identifier, c.body, c.created_at from issue_comments c join issues i on i.id = c.issue_id where i.company_id = $1 and i.project_id = $2 order by c.created_at desc limit 400",
      [companyId, projectId],
    );

    process.stdout.write(JSON.stringify({
      now: nowRes.rows[0]?.now ?? null,
      agents: agentsRes.rows,
      runs: runsRes.rows,
      issues: issuesRes.rows,
      docs: docsRes.rows,
      comments: commentsRes.rows,
      maxMonitorAgeSec,
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
`;

let raw;
try {
  raw = JSON.parse(runRemoteNode({ host, container, script: remoteScript }));
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  if (error.stdout) process.stdout.write(error.stdout);
  process.exit(error.status ?? 1);
}

const agentById = new Map((raw.agents || []).map((row) => [row.id, row]));
const docsByIdentifier = new Map();
for (const row of raw.docs || []) {
  const current = docsByIdentifier.get(row.identifier) || {};
  current[row.key] = row.latest_body;
  docsByIdentifier.set(row.identifier, current);
}
const commentsByIdentifier = new Map();
for (const row of raw.comments || []) {
  const current = commentsByIdentifier.get(row.identifier) || [];
  current.push({ body: row.body, createdAt: row.created_at });
  commentsByIdentifier.set(row.identifier, current);
}
const monitor = agentById.get(monitorAgentId) || null;
const latestMonitorRuns = (raw.runs || []).filter((row) => row.agent_id === monitorAgentId).slice(0, 8);
const activeRuns = (raw.runs || []).filter((row) => row.status === "queued" || row.status === "running");
const syntheticGroups = collectSyntheticGroups(raw.issues || [], raw.docs || []).filter((group) =>
  fingerprintFilter ? group.fingerprint === fingerprintFilter : true,
);
const bundles = (raw.issues || [])
  .filter((row) => String(row.title || "").startsWith("Release bundle:"))
  .map((row) => ({
    identifier: row.identifier,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
    hasBundlePlan: Boolean(String(docsByIdentifier.get(row.identifier)?.["bundle-plan"] || "").trim()),
    hasDeployApproval: (commentsByIdentifier.get(row.identifier) || []).some((entry) =>
      /(апрув на деплой\.|approve deploy\.)/i.test(String(entry.body || "")),
    ),
    hasIdleComment: (commentsByIdentifier.get(row.identifier) || []).some((entry) =>
      /буфер пуст, жду следующий аппрув на деплой\./i.test(String(entry.body || "")),
    ),
  }));

let prefilter = null;
try {
  const hostPrefilterScript = `
const crypto = require("node:crypto");
const fs = require("node:fs");
const target = "/opt/paperclip/data/docker-paperclip/bin/paperclip-incident-prefilter.mjs";
if (!fs.existsSync(target)) {
  process.stdout.write(JSON.stringify({ path: target, exists: false }, null, 2));
  process.exit(0);
}
const body = fs.readFileSync(target);
const stat = fs.statSync(target);
process.stdout.write(JSON.stringify({
  path: target,
  exists: true,
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
  size: stat.size,
  mtime: stat.mtime.toISOString(),
}, null, 2));
`;
  prefilter = JSON.parse(runSshCommand({ host, command: "node", script: hostPrefilterScript }));
} catch {
  prefilter = null;
}

const terminalStatuses = new Set(["done", "cancelled"]);
const violations = [];
if (!monitor) {
  violations.push({
    kind: "missing-monitor-agent",
    detail: "Paperclip Incident Monitor agent was not found in the company snapshot.",
  });
}
if (monitor?.last_heartbeat_at) {
  const ageMs = Date.parse(String(raw.now ?? "")) - Date.parse(String(monitor.last_heartbeat_at));
  if (Number.isFinite(ageMs) && ageMs > maxMonitorAgeSec * 1000) {
    violations.push({
      kind: "stale-monitor-heartbeat",
      detail: `Paperclip Incident Monitor last heartbeat is older than ${maxMonitorAgeSec}s.`,
      lastHeartbeatAt: monitor.last_heartbeat_at,
      ageSec: Math.round(ageMs / 1000),
    });
  }
}
if (activeRuns.length > 0) {
  violations.push({
    kind: "active-runs-present",
    detail: "There are queued or running heartbeat runs that may need inspection.",
    runs: activeRuns.map((row) => ({
      id: row.id,
      status: row.status,
      agentId: row.agent_id,
      agentName: agentById.get(row.agent_id)?.name || null,
      invocationSource: row.invocation_source,
      createdAt: row.created_at,
    })),
  });
}
for (const group of syntheticGroups) {
  if (group.issues.length <= 1) continue;
  const nonTerminal = group.issues.filter((issue) => !terminalStatuses.has(String(issue.status || "")));
  violations.push({
    kind: nonTerminal.length > 0 ? "synthetic-duplicate-active" : "synthetic-duplicate-historical",
    fingerprint: group.fingerprint,
    issues: group.issues,
  });
}

const summary = {
  now: raw.now,
  monitor,
  latestMonitorRuns,
  activeRuns: activeRuns.map((row) => ({
    ...row,
    agentName: agentById.get(row.agent_id)?.name || null,
  })),
  syntheticGroups,
  bundles,
  prefilter: prefilter?.exists
    ? {
        ...prefilter,
        shortSha: String(prefilter.sha256 || "").slice(0, 12),
      }
    : null,
  violations,
};

if (summaryMode) {
  const lines = [
    `monitor=${summary.monitor?.status ?? "missing"} adapter=${summary.monitor?.adapter_type ?? "missing"} lastHeartbeat=${summary.monitor?.last_heartbeat_at ?? "n/a"}`,
    `latestRun=${summary.latestMonitorRuns[0]?.id ?? "n/a"} latestRunStatus=${summary.latestMonitorRuns[0]?.status ?? "n/a"} activeRuns=${summary.activeRuns.length}`,
    `syntheticGroups=${summary.syntheticGroups.length} violations=${summary.violations.length}`,
    `prefilter=${summary.prefilter?.shortSha ?? "missing"} mtime=${summary.prefilter?.mtime ?? "n/a"}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
} else {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (failOnViolations) {
  const blocking = Array.isArray(summary.violations)
    ? summary.violations.filter((entry) => failOnHistorical || entry?.kind !== "synthetic-duplicate-historical")
    : [];
  if (blocking.length > 0) {
    process.exit(2);
  }
}
