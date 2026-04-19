import { spawnSync } from "node:child_process";

export function readArg(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

export function hasFlag(argv, flag) {
  return argv.includes(flag);
}

export function runRemoteNode({ host, container, script }) {
  return runSshCommand({ host, command: `docker exec -i ${container} node`, script });
}

export function runSshCommand({ host, command, script = null }) {
  const result = spawnSync("ssh", [host, command], {
    input: script,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const err = new Error(result.stderr || result.stdout || `Remote node command failed with status ${result.status}`);
    err.status = result.status ?? 1;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
}

export function summarizeReleaseCandidate(text) {
  const body = String(text || "");
  const normalized = body.replace(/\s+/g, " ").trim();
  const branchMain = /branch(?: name)?\s*:\s*(?:main|"main"|'main')/i.test(normalized);
  const noNewChanges = /no new branch changes required/i.test(normalized);
  const verificationOnly = /verification-only/i.test(normalized);
  return { branchMain, noNewChanges, verificationOnly, preview: normalized.slice(0, 240) };
}

export function chooseCanonical(issues) {
  const done = issues.filter((issue) => issue.status === "done");
  if (done.length > 0) {
    return [...done].sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt)))[0] || null;
  }
  const active = issues.filter((issue) => !["done", "cancelled"].includes(String(issue.status || "")));
  if (active.length > 0) {
    return [...active].sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt)))[0] || null;
  }
  return [...issues].sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt)))[0] || null;
}

export function describeCanonicalSelection(issues, canonical) {
  if (!canonical) return "no-canonical";
  const done = issues.filter((issue) => issue.status === "done");
  if (done.some((issue) => issue.id === canonical.id)) return "latest-done";
  const active = issues.filter((issue) => !["done", "cancelled"].includes(String(issue.status || "")));
  if (active.some((issue) => issue.id === canonical.id)) return "latest-active";
  return "latest-overall";
}

export function hasMeaningfulCandidate(issue) {
  const rc = issue.releaseCandidate || {};
  return !!rc.preview && !rc.branchMain && !rc.noNewChanges && !rc.verificationOnly;
}

export function shouldAutoCancel(issue, doneExists) {
  if (!doneExists) return false;
  if (["done", "cancelled"].includes(String(issue.status || ""))) return false;
  if (hasMeaningfulCandidate(issue)) return false;
  return true;
}

export function collectSyntheticGroups(issuesRows, docRows, { prefix = "synthetic-source-signal:" } = {}) {
  const issueByIdentifier = new Map(issuesRows.map((row) => [row.identifier, row]));
  const docsByIdentifier = new Map();
  for (const row of docRows) {
    const entry = docsByIdentifier.get(row.identifier) || {};
    entry[row.key] = row.latest_body;
    docsByIdentifier.set(row.identifier, entry);
  }

  const groups = new Map();
  for (const issue of issuesRows) {
    const docs = docsByIdentifier.get(issue.identifier) || {};
    const fingerprint = String(docs["incident-fingerprint"] || "").trim();
    if (!fingerprint.startsWith(prefix)) continue;
    const materialized = {
      id: issue.id,
      issueNumber: issue.issue_number,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      updatedAt: issue.updated_at ?? issue.updatedAt ?? null,
      createdAt: issue.created_at ?? issue.createdAt ?? null,
      assigneeAgentId: issue.assignee_agent_id ?? issue.assigneeAgentId ?? null,
      executionRunId: issue.execution_run_id ?? issue.executionRunId ?? null,
      sourceReference: String(docs["source-reference"] || "").replace(/\s+/g, " ").trim().slice(0, 220),
      releaseCandidate: summarizeReleaseCandidate(docs["release-candidate"] || ""),
    };
    const current = groups.get(fingerprint) || [];
    current.push(materialized);
    groups.set(fingerprint, current);
  }

  return Array.from(groups.entries())
    .map(([fingerprint, issues]) => ({ fingerprint, issues }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export function planSyntheticDuplicateReconciliation(groups, { fingerprint = null, limit = null } = {}) {
  const selected = groups.filter((group) => (fingerprint ? group.fingerprint === fingerprint : true));
  const plans = [];
  const manualReview = [];

  for (const group of selected) {
    if (group.issues.length <= 1) continue;
    const canonical = chooseCanonical(group.issues);
    if (!canonical) continue;
    const canonicalReason = describeCanonicalSelection(group.issues, canonical);
    const doneExists = group.issues.some((issue) => issue.status === "done");
    const duplicates = group.issues.filter((issue) => issue.id !== canonical.id);
    const toCancel = duplicates.filter((issue) => shouldAutoCancel(issue, doneExists));
    const needsReview = duplicates.filter(
      (issue) => !["done", "cancelled"].includes(String(issue.status || "")) && !toCancel.some((entry) => entry.id === issue.id),
    );
    if (toCancel.length > 0) {
      plans.push({
        fingerprint: group.fingerprint,
        canonical,
        canonicalReason,
        cancel: toCancel.map((issue) => ({
          ...issue,
          reconcileReason: "done sibling exists and duplicate has no meaningful unique release candidate",
        })),
      });
    }
    if (needsReview.length > 0) {
      manualReview.push({
        fingerprint: group.fingerprint,
        canonical,
        canonicalReason,
        review: needsReview.map((issue) => ({
          ...issue,
          reconcileReason: "duplicate still carries active or ambiguous candidate value; requires human review",
        })),
      });
    }
  }

  const applyLimit = Number.isFinite(limit) ? Number(limit) : null;
  if (applyLimit && applyLimit > 0) {
    return {
      plans: plans.slice(0, applyLimit),
      manualReview,
    };
  }
  return { plans, manualReview };
}
