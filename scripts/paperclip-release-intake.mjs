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

function parseSectionValue(markdown, heading) {
  const section = parseSection(markdown, heading);
  if (!section) return null;
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const first = lines[0].replace(/^-+\s*/, "").trim();
  return first || null;
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

function looksNoOpText(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  return [
    "no code diff",
    "no repository changes",
    "validation-only",
    "validation only",
    "deploy scope: none",
    "mr not required",
    "already fixed on live",
  ].some((marker) => normalized.includes(marker));
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

function stripWrappingBackticks(value) {
  return String(value || "").trim().replace(/^`|`$/g, "");
}

function parseBundleSectionItems(markdown, heading) {
  const section = parseSection(markdown, heading);
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseExistingIncludedIssues(markdown) {
  return parseBundleSectionItems(markdown, "Included issue ids")
    .map((line) => line.match(/`([^`]+)`/)?.[1] || line)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseExistingIncludedCommits(markdown) {
  return parseBundleSectionItems(markdown, "Included commits")
    .map((line) => line.match(/`([^`]+)`/)?.[1] || line)
    .map((value) => value.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildBundlePlan({
  scope,
  includedIssues,
  includedCommits,
  verifyTarget,
  expectedBehavior,
  proofKind,
}) {
  const normalizedIssues = unique(includedIssues);
  const normalizedCommits = unique(includedCommits);

  const verifyLines = [
    "## Verify Target",
    "",
    `- target: ${verifyTarget || "exact proof target from release-candidate"}`,
    `- expected restored behavior: ${expectedBehavior || "restored behavior from release-candidate"}`,
    `- proof kind: \`${proofKind || "other"}\``,
  ];

  return [
    "## Scope",
    `- \`${scope}\``,
    "",
    "## Included issue ids",
    ...normalizedIssues.map((issueIdentifier) => `- \`${issueIdentifier}\``),
    "",
    "## Included commits",
    ...normalizedCommits.map((commit) => `- \`${commit}\``),
    "",
    "## Excluded or rejected candidates",
    "- none",
    "",
    "## Deploy order",
    "1. wait for a fresh manual approval comment on this bundle;",
    "2. deliver the approved commit(s) to the delivery branch for this scope;",
    "3. execute the exact post-deploy verify target from the release-candidate before closure.",
    "",
    "## Rollback note",
    `- revert delivered commit(s) \`${normalizedCommits.join(", ")}\` from the delivery branch and re-run the scope verification.`,
    "",
    "## Approval state",
    "- `pending_manual_approval`",
    "",
    ...verifyLines,
    "",
    "## Buffer State",
    "",
    `- pending entries: \`${normalizedIssues.join(", ")}\``,
  ].join("\n");
}

async function main() {
  const issue = await api(`/api/issues/${encodeURIComponent(issueId)}`);
  const candidateDoc = await api(`/api/issues/${encodeURIComponent(issueId)}/documents/release-candidate`);
  const candidateBody = String(candidateDoc.body || "");

  const repoUrl = parseSectionValue(candidateBody, "Affected Repo") || parseInlineValue(candidateBody, "affected repo");
  const branchName = parseSectionValue(candidateBody, "Branch Name") || parseInlineValue(candidateBody, "branch name");
  const commitSha = parseSectionValue(candidateBody, "Commit SHA") || parseInlineValue(candidateBody, "commit sha");
  const explicitScope = parseSectionValue(candidateBody, "Deploy Scope") || parseInlineValue(candidateBody, "deploy scope");
  const mrStatus = parseSectionValue(candidateBody, "MR URL or Status") || parseInlineValue(candidateBody, "MR URL or status");
  const riskNotes = parseSectionValue(candidateBody, "Risk Notes") || parseInlineValue(candidateBody, "risk notes");
  const verificationNotes = parseSection(candidateBody, "Verification notes") || parseSection(candidateBody, "Verification Notes") || "";
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
  if (
    looksNoOpText(explicitScope) ||
    looksNoOpText(mrStatus) ||
    looksNoOpText(riskNotes) ||
    looksNoOpText(verificationNotes)
  ) {
    throw new Error("release-candidate describes an evidence-only or no-op pass, not a deployable repo change");
  }

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

  let existingBundlePlanBody = "";
  let bundlePlanBaseRevisionId = null;
  try {
    const existingBundlePlan = await api(`/api/issues/${encodeURIComponent(bundle.id)}/documents/bundle-plan`);
    existingBundlePlanBody = String(existingBundlePlan?.body || "");
    bundlePlanBaseRevisionId = existingBundlePlan?.latestRevisionId || null;
  } catch {
    existingBundlePlanBody = "";
    bundlePlanBaseRevisionId = null;
  }

  const bundlePlanBody = buildBundlePlan({
    scope,
    includedIssues: unique([...parseExistingIncludedIssues(existingBundlePlanBody), candidateIdentifier]),
    includedCommits: unique([...parseExistingIncludedCommits(existingBundlePlanBody), stripWrappingBackticks(commitSha)]),
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
      baseRevisionId: bundlePlanBaseRevisionId,
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
