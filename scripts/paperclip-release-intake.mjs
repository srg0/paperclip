#!/usr/bin/env node

import process from "node:process";

const apiBase = process.env.PAPERCLIP_API_URL;
const apiKey = process.env.PAPERCLIP_API_KEY;
const runId = process.env.PAPERCLIP_RUN_ID;
const agentId = process.env.PAPERCLIP_AGENT_ID;
const issueId = process.env.PAPERCLIP_TASK_ID;

if (!apiBase || !apiKey || !runId || !agentId || !issueId) {
  console.error("Missing required PAPERCLIP_* env vars for release intake");
  process.exit(1);
}

function headers(withRunId = false) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(withRunId ? { "X-Paperclip-Run-Id": runId } : {}),
  };
}

async function api(pathname, init = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...init,
    headers: {
      ...headers(Boolean(init.withRunId)),
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
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${pathname} failed: ${response.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

function parseInlineValue(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inlineCode = new RegExp(`^- ${escaped}:\\s*\\\`([^\\\`]+)\\\``, "mi");
  const plain = new RegExp(`^- ${escaped}:\\s*(.+)$`, "mi");
  return markdown.match(inlineCode)?.[1]?.trim() || markdown.match(plain)?.[1]?.trim() || null;
}

function parseSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`## ${escaped}\\n\\n([\\s\\S]*?)(?:\\n## |$)`));
  return match?.[1]?.trim() || null;
}

function isPlaceholderLike(value) {
  if (!value) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return true;
  return [
    "placeholder",
    "tbd",
    "todo",
    "n/a",
    "na",
    "unknown",
    "null",
    "none",
    "-",
  ].some((marker) => normalized === marker || normalized.includes(marker));
}

function assertConcreteField(label, value) {
  if (isPlaceholderLike(value)) {
    throw new Error(`release-candidate field "${label}" must be concrete, not placeholder-like`);
  }
}

function normalizeScope(repoUrl, explicitScope) {
  if (explicitScope) return explicitScope;
  if (repoUrl === "ssh://git@gitlab.kdigital.pro:55555/homio/paperclip-control-plane.git") {
    return "paperclip-control-plane";
  }
  if (repoUrl === "ssh://git@gitlab.kdigital.pro:55555/homio/paperclip-atlas-bridge.git") {
    return "paperclip-atlas-bridge";
  }
  if (repoUrl === "ssh://git@gitlab.kdigital.pro:55555/homio/atlas.git") {
    return "homio-atlas";
  }
  throw new Error(`Unsupported repo url for deploy scope mapping: ${repoUrl}`);
}

function issueLink(identifier) {
  const prefix = String(identifier).split("-")[0];
  return `/${prefix}/issues/${identifier}`;
}

function buildBundlePlan({
  scope,
  candidateIdentifier,
  commitSha,
  verifyTarget,
  expectedBehavior,
  proofKind,
}) {
  const verifyLines = [
    "## Verify Target",
    "",
    `- target: ${verifyTarget || "exact proof target from release-candidate"}`,
    `- expected restored behavior: ${expectedBehavior || "restored behavior from release-candidate"}`,
    `- proof kind: \`${proofKind || "other"}\``,
  ];

  return [
    "## Bundle Plan",
    "",
    `- scope: \`${scope}\``,
    `- included issue ids: \`${candidateIdentifier}\``,
    `- included commits: \`${commitSha}\``,
    "- excluded or rejected candidates:",
    "  - none",
    "- deploy order:",
    "  1. wait for a fresh manual approval comment on this bundle;",
    "  2. deliver the approved commit to the delivery branch for this scope;",
    "  3. execute the exact post-deploy verify target from the release-candidate before closure.",
    `- rollback note: revert \`${commitSha}\` from the delivery branch and re-run the scope verification.`,
    "- approval state: `pending_manual_approval`",
    "",
    ...verifyLines,
    "",
    "## Buffer State",
    "",
    `- pending entries: \`${candidateIdentifier}\``,
  ].join("\n");
}

async function main() {
  const issue = await api(`/api/issues/${encodeURIComponent(issueId)}`);
  const candidateDoc = await api(`/api/issues/${encodeURIComponent(issueId)}/documents/release-candidate`);
  const candidateBody = String(candidateDoc.body || "");

  const repoUrl = parseInlineValue(candidateBody, "affected repo");
  const branchName = parseInlineValue(candidateBody, "branch name");
  const commitSha = parseInlineValue(candidateBody, "commit sha");
  const explicitScope = parseInlineValue(candidateBody, "deploy scope");
  const scope = normalizeScope(repoUrl, explicitScope);
  const candidateIdentifier = String(issue.identifier || issue.id);
  const verifySection = parseSection(candidateBody, "Post-Deploy Verify Target");
  const verifyTarget = parseInlineValue(verifySection || "", "target");
  const expectedBehavior = parseInlineValue(verifySection || "", "expected restored behavior");
  const proofKind = parseInlineValue(verifySection || "", "proof kind");

  if (!issue.projectId) {
    throw new Error("Candidate issue has no projectId");
  }
  if (!issue.projectWorkspaceId) {
    throw new Error("Candidate issue has no projectWorkspaceId");
  }
  assertConcreteField("affected repo", repoUrl);
  assertConcreteField("branch name", branchName);
  assertConcreteField("commit sha", commitSha);
  assertConcreteField("verify target", verifyTarget);
  assertConcreteField("expected restored behavior", expectedBehavior);
  assertConcreteField("proof kind", proofKind);

  const openIssues = await api(
    `/api/companies/${encodeURIComponent(issue.companyId)}/issues?projectId=${encodeURIComponent(issue.projectId)}&limit=200&status=backlog,todo,in_progress,in_review,blocked`,
  );
  const bundleTitle = `Release bundle: ${scope}`;
  let bundle = Array.isArray(openIssues)
    ? openIssues.find((entry) => entry?.title === bundleTitle && entry?.status !== "done" && entry?.status !== "cancelled")
    : null;

  if (!bundle) {
    bundle = await api(`/api/companies/${encodeURIComponent(issue.companyId)}/issues`, {
      method: "POST",
      withRunId: true,
      body: JSON.stringify({
        projectId: issue.projectId,
        projectWorkspaceId: issue.projectWorkspaceId,
        title: bundleTitle,
        description: `Буфер релиза для scope ${scope}. Сюда попадают только ready release-candidate перед ручным апрувом на деплой.`,
        status: "backlog",
        priority: "medium",
        assigneeAgentId: agentId,
      }),
    });
  }

  const bundlePlanBody = buildBundlePlan({
    scope,
    candidateIdentifier,
    commitSha,
    verifyTarget,
    expectedBehavior,
    proofKind,
  });

  await api(`/api/issues/${encodeURIComponent(bundle.id)}/documents/bundle-plan`, {
    method: "PUT",
    withRunId: true,
    body: JSON.stringify({
      title: "Bundle Plan",
      format: "markdown",
      body: bundlePlanBody,
      changeSummary: `Intake ${candidateIdentifier} into ${scope} bundle`,
      baseRevisionId: null,
    }),
  });

  const bundleIdentifier = String(bundle.identifier || bundle.id);
  await api(`/api/issues/${encodeURIComponent(bundle.id)}/comments`, {
    method: "POST",
    withRunId: true,
    body: JSON.stringify({
      body: [
        "## Intake update",
        "",
        `Переиспользую bundle [${bundleIdentifier}](${issueLink(bundleIdentifier)}) для \`${scope}\`.`,
        "",
        `- Включено: [${candidateIdentifier}](${issueLink(candidateIdentifier)}), commit \`${commitSha}\``,
        `- План обновлён: [bundle-plan](${issueLink(bundleIdentifier)}#document-bundle-plan)`,
        "- Approval state: `pending_manual_approval`",
        "- Старые approval-комментарии не переиспользуются; нужен новый явный комментарий для этого intake.",
        "",
        "Для деплоя нужен новый явный комментарий на этом bundle: `Апрув на деплой.` или `Approve deploy.`",
      ].join("\n"),
    }),
  });

  await api(`/api/issues/${encodeURIComponent(issue.id)}`, {
    method: "PATCH",
    withRunId: true,
    body: JSON.stringify({
      status: "in_review",
      assigneeAgentId: agentId,
      comment: [
        "## Bundle linked",
        "",
        `- bundle [${bundleIdentifier}](${issueLink(bundleIdentifier)})`,
        `- deploy scope: \`${scope}\``,
        `- commit: \`${commitSha}\``,
        "- approval state: `pending_manual_approval`",
        `- следующий шаг: новый ручной комментарий \`Апрув на деплой.\` на bundle [${bundleIdentifier}](${issueLink(bundleIdentifier)})`,
      ].join("\n"),
    }),
  });

  console.log(
    JSON.stringify({
      candidateIssue: candidateIdentifier,
      bundleIssue: bundleIdentifier,
      scope,
      repoUrl,
      branchName,
      commitSha,
      proofKind,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
