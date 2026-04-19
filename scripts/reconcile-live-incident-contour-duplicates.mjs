#!/usr/bin/env node

import {
  collectSyntheticGroups,
  hasFlag,
  planSyntheticDuplicateReconciliation,
  readArg,
  runRemoteNode,
} from "./lib/incident-contour-ops.mjs";

const argv = process.argv;
const host = readArg(argv, "--host", "dev-cnt-pcl01");
const container = readArg(argv, "--container", "docker-paperclip-1");
const companyId = readArg(argv, "--company-id", "5f7311ad-c84a-4c17-96ba-b3744e2e2401");
const projectId = readArg(argv, "--project-id", "2e901644-af0a-4d25-84bf-6b15d1ebd65c");
const monitorAgentId = readArg(argv, "--monitor-agent-id", "4b77eabf-bf69-453c-8e78-d7ab1fe08ca1");
const fingerprint = readArg(argv, "--fingerprint", null);
const limit = Number(readArg(argv, "--limit", "0")) || null;
const apply = hasFlag(argv, "--apply");

const snapshotScript = `
const { Client } = require("/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg");

async function main() {
  const companyId = ${JSON.stringify(companyId)};
  const projectId = ${JSON.stringify(projectId)};

  const client = new Client({ connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip" });
  await client.connect();

  try {
    const issuesRes = await client.query(
      "select id, issue_number, identifier, title, status, updated_at, created_at, assignee_agent_id, execution_run_id from issues where company_id = $1 and project_id = $2 order by issue_number desc limit 400",
      [companyId, projectId],
    );
    const docsRes = await client.query(
      "select i.id as issue_id, i.identifier, idoc.key, d.latest_body from issue_documents idoc join issues i on i.id = idoc.issue_id join documents d on d.id = idoc.document_id where i.company_id = $1 and i.project_id = $2",
      [companyId, projectId],
    );

    const docsByIssueId = new Map();
    for (const row of docsRes.rows) {
      const current = docsByIssueId.get(row.issue_id) || {};
      current[row.key] = row.latest_body;
      docsByIssueId.set(row.issue_id, current);
    }

    process.stdout.write(JSON.stringify({ issues: issuesRes.rows, docs: docsRes.rows }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
`;

const applyScript = (payload) => `
const { Client } = require("/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg");

async function main() {
  const companyId = ${JSON.stringify(companyId)};
  const monitorAgentId = ${JSON.stringify(monitorAgentId)};
  const payload = ${JSON.stringify(payload)};
  const client = new Client({ connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip" });
  await client.connect();
  try {
    const applied = [];
    for (const plan of payload.plans || []) {
      for (const duplicate of plan.cancel || []) {
        const comment =
          "Cancelled as duplicate of canonical internal incident " +
          plan.canonical.identifier +
          " after incident-contour synthetic dedupe reconciliation. " +
          "Fingerprint: " + plan.fingerprint + ". " +
          "If the branch or commit still carries unique value, reopen it under a materially changed source contract instead of reusing the same fingerprint.";
        await client.query(
          "insert into issue_comments (company_id, issue_id, author_agent_id, body, created_at, updated_at) values ($1, $2, $3, $4, now(), now())",
          [companyId, duplicate.id, monitorAgentId, comment],
        );
        await client.query(
          "update issues set status = $1, execution_run_id = null, checkout_run_id = null, execution_locked_at = null, cancelled_at = coalesce(cancelled_at, now()), updated_at = now() where id = $2",
          ["cancelled", duplicate.id],
        );
        applied.push({
          identifier: duplicate.identifier,
          fingerprint: plan.fingerprint,
          canonicalIdentifier: plan.canonical.identifier,
        });
      }
    }
    process.stdout.write(JSON.stringify({ applied }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
`;

let snapshot;
try {
  snapshot = JSON.parse(runRemoteNode({ host, container, script: snapshotScript }));
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  if (error.stdout) process.stdout.write(error.stdout);
  process.exit(error.status ?? 1);
}

const groups = collectSyntheticGroups(snapshot.issues || [], snapshot.docs || []);
const { plans, manualReview } = planSyntheticDuplicateReconciliation(groups, { fingerprint, limit });

const output = {
  apply,
  plans,
  manualReview,
  applied: [],
};

if (apply && plans.length > 0) {
  try {
    const appliedResult = JSON.parse(runRemoteNode({ host, container, script: applyScript({ plans }) }));
    output.applied = appliedResult.applied || [];
  } catch (error) {
    if (error.stderr) process.stderr.write(error.stderr);
    if (error.stdout) process.stdout.write(error.stdout);
    process.exit(error.status ?? 1);
  }
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
