#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const API_BASE = process.env.PAPERCLIP_API_URL || "https://org.homio.pro";
const AUTH_FILE = process.env.PAPERCLIP_AUTH_FILE || path.join(process.env.HOME || "", ".paperclip", "auth.json");
const SOURCE_PREFIX = "TEST: synthetic Atlas-path source failure";
const INCIDENT_PROJECT_ID = "2e901644-af0a-4d25-84bf-6b15d1ebd65c";
const MONITOR_AGENT_ID = "4b77eabf-bf69-453c-8e78-d7ab1fe08ca1";
const DEFAULT_EXTERNAL_PROJECT_ID =
  process.env.PAPERCLIP_VALIDATION_SOURCE_PROJECT_ID || "1662bb42-cbe0-4c71-8a56-3ba43adc227d";
const DEFAULT_TIMEOUT_MS = Number(process.env.PAPERCLIP_VALIDATION_TIMEOUT_MS || "1800000");
const POLL_MS = Number(process.env.PAPERCLIP_VALIDATION_POLL_MS || "10000");
const API_RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);
const API_MAX_ATTEMPTS = Number(process.env.PAPERCLIP_VALIDATION_API_RETRIES || "6");
const API_RETRY_BASE_MS = Number(process.env.PAPERCLIP_VALIDATION_API_RETRY_BASE_MS || "1000");

const scenarios = [
  {
    key: "bundle-idle-state",
    streamAgentName: "Delivery Orchestrator",
    owningRepo: "ssh://git@gitlab.kdigital.pro:55555/homio/paperclip-control-plane.git",
    title: "bundle idle state stays active after deploy",
    failureClass: "paperclip.release.bundle_idle_state",
    expectedFailure:
      "Reusable release bundle stays active instead of a clear idle waiting state after deploy proof is already written.",
    allowedChangeSurface: [
      "config/agent-instructions/homio/paperclip-release-manager/**",
      "docs/paperclip-incident-*",
    ],
    repro: [
      "Use the current reusable bundle flow in Paperclip Incident Contour.",
      "After deploy proof is already recorded and no new candidates are ready, the bundle should no longer look like an active deploy turn.",
    ],
    postDeployVerify: [
      "Proof kind: bundle-state",
      "Bundle issue comment must explicitly say the buffer is empty and waiting for the next approval.",
      "Bundle issue status must reflect idle waiting state rather than active in-progress execution.",
    ],
    closureRule:
      "Close only after the bundle state and comment shape match the idle reusable-buffer contract.",
  },
  {
    key: "self-verify-contract",
    streamAgentName: "Atlas Executor",
    owningRepo: "ssh://git@gitlab.kdigital.pro:55555/homio/paperclip-control-plane.git",
    title: "non-atlas scopes need exact self-verify contract",
    failureClass: "paperclip.release.self_verify_contract",
    expectedFailure:
      "Release contract for Paperclip and bridge scopes is too vague and allows closure on generic green status instead of exact proof target.",
    allowedChangeSurface: [
      "config/agent-instructions/homio/paperclip-release-manager/**",
      "docs/paperclip-incident-*",
    ],
    repro: [
      "Read Paperclip release-manager contract and validation docs.",
      "The self-verify clause is currently explicit only for homio-atlas incidents.",
    ],
    postDeployVerify: [
      "Proof kind: document",
      "Release-manager contract and validation docs must define exact post-deploy proof for Paperclip and bridge scopes.",
      "The internal incident comment must name the exact restored proof target instead of a generic green summary.",
    ],
    closureRule:
      "Close only when the deployed Paperclip repo text makes the self-verify contract symmetric across scopes.",
  },
  {
    key: "malformed-a2a-task-route",
    streamAgentName: "Technical Verifier",
    owningRepo: "ssh://git@gitlab.kdigital.pro:55555/homio/atlas.git",
    title: "malformed a2a task routes return 500",
    failureClass: "atlas.runtime.malformed_a2a_task_route",
    expectedFailure:
      "Malformed task ids on A2A task route family return 500 URI malformed instead of safe client error / not-found response.",
    allowedChangeSurface: [
      "scripts/mini-app/server.ts",
      "related tests for the same route family",
    ],
    repro: [
      "Use ATLAS_A2A_TOKEN from repo-local runtime env if needed.",
      "Check GET /api/a2a/tasks/%ZZ, GET /api/a2a/tasks/%ZZ/events, GET /api/a2a/tasks/%ZZ/artifacts on https://atlas.homio.pro.",
      "For POST /api/a2a/tasks/%ZZ/status, send a valid JSON status payload so the verify step isolates malformed task-id handling instead of request-body validation.",
      "Current failure is HTTP 500 with body containing URI malformed.",
    ],
    postDeployVerify: [
      "Proof kind: authenticated-api",
      "The listed A2A task routes must return 400 or 404, not 500.",
      "The POST /status proof must use a valid JSON payload, for example `{\"status\":\"submitted\"}`.",
      "Deploy proof must include the main pipeline URL and the exact live HTTP results.",
    ],
    closureRule:
      "Close only after live authenticated API calls confirm the malformed route family no longer returns 500.",
  },
  {
    key: "malformed-runtime-work-thread-route",
    streamAgentName: "Reporter",
    owningRepo: "ssh://git@gitlab.kdigital.pro:55555/homio/atlas.git",
    title: "malformed runtime work-thread route returns 500",
    failureClass: "atlas.runtime.malformed_runtime_work_thread_route",
    expectedFailure:
      "Malformed work-thread ids on runtime route family return 500 URI malformed instead of safe client error / not-found response.",
    allowedChangeSurface: [
      "scripts/mini-app/server.ts",
      "related tests for the same route family",
    ],
    repro: [
      "Use ATLAS_A2A_TOKEN from repo-local runtime env if needed.",
      "Check GET /api/runtime/work-threads/%ZZ on https://atlas.homio.pro.",
      "Current failure is HTTP 500 with body containing URI malformed.",
    ],
    postDeployVerify: [
      "Proof kind: authenticated-api",
      "GET /api/runtime/work-threads/%ZZ must return 400 or 404, not 500.",
      "Deploy proof must include the main pipeline URL and the exact live HTTP result.",
    ],
    closureRule:
      "Close only after live authenticated API call confirms the route no longer returns 500.",
  },
  {
    key: "bridge-self-verify-contract",
    streamAgentName: "Stand Controller",
    owningRepo: "ssh://git@gitlab.kdigital.pro:55555/homio/paperclip-atlas-bridge.git",
    title: "bridge release contract lacks exact self-verify",
    failureClass: "bridge.release.self_verify_contract",
    expectedFailure:
      "Bridge contour contract stops at build/package proof and does not force an exact post-deploy self-verify step for the installed plugin/runtime effect.",
    allowedChangeSurface: [
      "docs/paperclip-incident-contour-bridge-contract.md",
      "AGENTS.md",
      "other bridge contract docs only if required for consistency",
    ],
    repro: [
      "Read the bridge contour contract and repo validation checklist.",
      "The contract currently stops at package/build validation and does not name the required post-deploy proof shape.",
    ],
    postDeployVerify: [
      "Proof kind: document",
      "Bridge contour contract must require packaged artifact proof plus Paperclip-side or live-effect verification after deploy.",
      "Deploy proof must include the bridge repo main commit and the validation command/result used for the contract update.",
    ],
    closureRule:
      "Close only when the bridge contract text explicitly names post-deploy self-verify for contour-driven releases.",
  },
];

function selectScenarios(allScenarios) {
  const raw = process.env.PAPERCLIP_VALIDATION_SCENARIOS?.trim();
  if (!raw) return allScenarios;
  const requested = new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const selected = allScenarios.filter((scenario) => requested.has(scenario.key));
  if (selected.length !== requested.size) {
    const known = new Set(allScenarios.map((scenario) => scenario.key));
    const missing = [...requested].filter((key) => !known.has(key));
    throw new Error(`Unknown validation scenario key(s): ${missing.join(", ")}`);
  }
  return selected;
}

async function readAuthToken() {
  if (process.env.PAPERCLIP_AUTH_TOKEN?.trim()) {
    return process.env.PAPERCLIP_AUTH_TOKEN.trim();
  }
  const raw = await readFile(AUTH_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const credentials = Array.isArray(parsed?.credentials)
    ? parsed.credentials
    : parsed?.credentials && typeof parsed.credentials === "object"
      ? Object.values(parsed.credentials)
      : [];
  const match = credentials.find((entry) => entry?.apiBase === API_BASE);
  if (!match?.token) {
    throw new Error(`No auth token for ${API_BASE} in ${AUTH_FILE}`);
  }
  return String(match.token).trim();
}

async function api(token, pathname, init = {}) {
  for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${API_BASE}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (response.ok) {
      return data;
    }

    const shouldRetry =
      API_RETRYABLE_STATUS_CODES.has(response.status) && attempt < API_MAX_ATTEMPTS;
    if (shouldRetry) {
      const delayMs = API_RETRY_BASE_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${init.method || "GET"} ${pathname} failed: ${response.status} ${detail}`);
  }

  throw new Error(`${init.method || "GET"} ${pathname} failed after ${API_MAX_ATTEMPTS} attempts`);
}

async function getCompany(token) {
  if (process.env.PAPERCLIP_COMPANY_ID?.trim()) {
    return api(token, `/api/companies/${encodeURIComponent(process.env.PAPERCLIP_COMPANY_ID.trim())}`);
  }
  const companies = await api(token, "/api/companies");
  const match = Array.isArray(companies)
    ? companies.find((item) => item?.name === "Homio")
    : null;
  if (!match?.id) {
    throw new Error("Homio company not found");
  }
  return match;
}

async function getAgentsByName(token, companyId) {
  const agents = await api(token, `/api/companies/${encodeURIComponent(companyId)}/agents`);
  const byName = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent?.name) byName.set(agent.name, agent);
  }
  return byName;
}

function buildSourceDescription(scenario) {
  return [
    "# Incident Validation Contract",
    "",
    `- Stream agent: ${scenario.streamAgentName}`,
    `- Owning repo: ${scenario.owningRepo}`,
    `- Failure class: ${scenario.failureClass}`,
    `- Signal kind: synthetic_validation`,
    "",
    "## Expected failure",
    "",
    scenario.expectedFailure,
    "",
    "## Allowed change surface",
    "",
    ...scenario.allowedChangeSurface.map((item) => `- ${item}`),
    "",
    "## Repro",
    "",
    ...scenario.repro.map((item) => `- ${item}`),
    "",
    "## Post-deploy verify",
    "",
    ...scenario.postDeployVerify.map((item) => `- ${item}`),
    "",
    "## Closure rule",
    "",
    scenario.closureRule,
  ].join("\n");
}

async function createSourceIssue(token, companyId, agentId, scenario) {
  const title = `${SOURCE_PREFIX}: ${scenario.key}`;
  return api(token, `/api/companies/${encodeURIComponent(companyId)}/issues`, {
    method: "POST",
    body: JSON.stringify({
      projectId: DEFAULT_EXTERNAL_PROJECT_ID,
      title,
      description: buildSourceDescription(scenario),
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    }),
  });
}

async function wakeMonitor(token) {
  return api(token, `/api/agents/${encodeURIComponent(MONITOR_AGENT_ID)}/wakeup`, {
    method: "POST",
    body: JSON.stringify({ reason: "validation_pack" }),
  });
}

async function listProjectIssues(token, companyId) {
  return api(
    token,
    `/api/companies/${encodeURIComponent(companyId)}/issues?projectId=${encodeURIComponent(INCIDENT_PROJECT_ID)}&limit=200&status=backlog,todo,in_progress,blocked,in_review,done`,
  );
}

async function getIssueComments(token, issueId) {
  return api(token, `/api/issues/${encodeURIComponent(issueId)}/comments?limit=200`);
}

async function findInternalIssueForSource(token, companyId, sourceIdentifier) {
  const issues = await listProjectIssues(token, companyId);
  const title = `Инцидент: synthetic source signal ${sourceIdentifier}`;
  return Array.isArray(issues)
    ? issues.find((item) => item?.title === title) || null
    : null;
}

function commentBodyText(comment) {
  return String(comment?.body || "");
}

async function maybeApproveBundle(token, bundleIssueId) {
  await api(token, `/api/issues/${encodeURIComponent(bundleIssueId)}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "Апрув на деплой." }),
  });
  return true;
}

async function closeSyntheticSourceIssue(token, sourceIssue, internalIssue) {
  if (!sourceIssue?.id) {
    return;
  }
  if (sourceIssue.status === "done") {
    return;
  }
  await api(token, `/api/issues/${encodeURIComponent(sourceIssue.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "done",
      comment: [
        "Synthetic validation source closed after internal contour remediation.",
        "",
        `- internal incident: ${internalIssue.identifier || internalIssue.id}`,
        "- reason: avoid repeated synthetic re-intake after successful deploy/verify",
      ].join("\n"),
    }),
  });
}

async function waitForScenario(token, companyId, sourceIssue) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  const sourceIdentifier = String(sourceIssue.identifier || sourceIssue.id);
  let lastInternalIssueId = null;
  const approvedBundles = new Set();

  while (Date.now() < deadline) {
    const internalIssue = await findInternalIssueForSource(token, companyId, sourceIdentifier);
    if (internalIssue?.id) {
      lastInternalIssueId = internalIssue.id;
      const comments = await getIssueComments(token, internalIssue.id);
      const items = Array.isArray(comments) ? comments : [];
      for (const item of items) {
        const body = commentBodyText(item);
        const match = body.match(/bundle \[HOM-(\d+)\]\(\/HOM\/issues\/HOM-\d+\)/i);
        if (!match) continue;
        const bundleIdentifier = `HOM-${match[1]}`;
        const projectIssues = await listProjectIssues(token, companyId);
        const bundle = Array.isArray(projectIssues)
          ? projectIssues.find((entry) => String(entry?.identifier || "") === bundleIdentifier)
          : null;
        if (bundle?.id && !approvedBundles.has(bundle.id)) {
          await maybeApproveBundle(token, bundle.id);
          approvedBundles.add(bundle.id);
        }
      }
      const freshIssue = await api(token, `/api/issues/${encodeURIComponent(internalIssue.id)}`);
      if (freshIssue.status === "done") {
        return freshIssue;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  throw new Error(
    `Timed out waiting for scenario ${sourceIdentifier}. Last internal issue: ${lastInternalIssueId || "n/a"}`,
  );
}

async function main() {
  const token = await readAuthToken();
  const company = await getCompany(token);
  const agentsByName = await getAgentsByName(token, company.id);
  const selectedScenarios = selectScenarios(scenarios);

  for (const scenario of selectedScenarios) {
    const sourceAgent = agentsByName.get(scenario.streamAgentName);
    if (!sourceAgent?.id) {
      throw new Error(`Agent not found: ${scenario.streamAgentName}`);
    }
    const sourceIssue = await createSourceIssue(token, company.id, sourceAgent.id, scenario);
    await wakeMonitor(token);
    const internalIssue = await waitForScenario(token, company.id, sourceIssue);
    await closeSyntheticSourceIssue(token, sourceIssue, internalIssue);
    console.log(
      JSON.stringify({
        scenario: scenario.key,
        sourceIssue: sourceIssue.identifier || sourceIssue.id,
        internalIssue: internalIssue.identifier || internalIssue.id,
        status: internalIssue.status,
      }),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
