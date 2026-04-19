import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseCanonical,
  collectSyntheticGroups,
  hasMeaningfulCandidate,
  planSyntheticDuplicateReconciliation,
  shouldAutoCancel,
} from "./lib/incident-contour-ops.mjs";

test("chooseCanonical prefers latest done issue", () => {
  const canonical = chooseCanonical([
    { id: "a", status: "in_progress", updatedAt: "2026-04-18T10:00:00Z" },
    { id: "b", status: "done", updatedAt: "2026-04-18T11:00:00Z" },
    { id: "c", status: "done", updatedAt: "2026-04-18T12:00:00Z" },
  ]);
  assert.equal(canonical?.id, "c");
});

test("meaningful candidate blocks auto-cancel", () => {
  const issue = {
    status: "in_progress",
    releaseCandidate: {
      preview: "Branch: fix/hom-867 ... commit: abc123",
      branchMain: false,
      noNewChanges: false,
      verificationOnly: false,
    },
  };
  assert.equal(hasMeaningfulCandidate(issue), true);
  assert.equal(shouldAutoCancel(issue, true), false);
});

test("verification-only candidate can be auto-cancelled when done sibling exists", () => {
  const issue = {
    status: "in_review",
    releaseCandidate: {
      preview: "verification-only rollout check",
      branchMain: false,
      noNewChanges: false,
      verificationOnly: true,
    },
  };
  assert.equal(shouldAutoCancel(issue, true), true);
});

test("group collection and reconciliation planning are stable", () => {
  const issues = [
    { id: "1", issue_number: 844, identifier: "HOM-844", title: "canonical", status: "done", updated_at: "2026-04-18T12:00:00Z" },
    { id: "2", issue_number: 867, identifier: "HOM-867", title: "duplicate", status: "in_progress", updated_at: "2026-04-18T11:00:00Z" },
    { id: "3", issue_number: 900, identifier: "HOM-900", title: "other", status: "done", updated_at: "2026-04-18T12:00:00Z" },
  ];
  const docs = [
    { identifier: "HOM-844", key: "incident-fingerprint", latest_body: "synthetic-source-signal:HOM-843" },
    { identifier: "HOM-867", key: "incident-fingerprint", latest_body: "synthetic-source-signal:HOM-843" },
    { identifier: "HOM-867", key: "release-candidate", latest_body: "Branch: fix/hom-867 Commit: abc123" },
    { identifier: "HOM-900", key: "incident-fingerprint", latest_body: "synthetic-source-signal:HOM-900" },
  ];

  const groups = collectSyntheticGroups(issues, docs);
  assert.equal(groups.length, 2);

  const planned = planSyntheticDuplicateReconciliation(groups);
  assert.equal(planned.plans.length, 0);
  assert.equal(planned.manualReview.length, 1);
  assert.equal(planned.manualReview[0]?.fingerprint, "synthetic-source-signal:HOM-843");
  assert.equal(planned.manualReview[0]?.canonicalReason, "latest-done");
  assert.equal(planned.manualReview[0]?.review[0]?.identifier, "HOM-867");
  assert.match(planned.manualReview[0]?.review[0]?.reconcileReason || "", /requires human review/i);
});
