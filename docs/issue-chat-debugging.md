# Issue Chat Debugging

Primary command:

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
pnpm debug:issue-chat -- --issue HOM-957
```

Output:

- JSON report in `/Users/s1z0v/kd-projects/Paperclip/state/reports/issue-chat-debug/<ISSUE>/...json`
- Markdown summary in `/Users/s1z0v/kd-projects/Paperclip/state/reports/issue-chat-debug/<ISSUE>/...md`

What the report includes:

- raw API truth for the issue
  - `issue`
  - `comments`
  - `documents`
  - `activity`
  - `runs`
  - `live-runs`
  - `active-run`
- parsed `atlas-execution` projection
- derived turn context from `buildIssueExecutionCommentContext(...)`
- derived conversation surface from `buildIssueConversationModel(...)`
- anomaly detection for the most common UI lies

Current anomaly classes:

- `empty_bundle_items`
  - a badge says `N`, but the expanded bundle has no actual items
- `stale_surface_status`
  - surface says `Queued` or `Running`, but API truth has no `active-run` and no `live-runs`
- `pending_requests_not_materialized`
  - pending follow-up comments were parsed, but did not become folded message items
- `issue_in_progress_without_live_execution`
  - issue status says `in_progress`, but there is no real live execution
- `execution_projection_stale`
  - `atlas-execution` is behind the latest turn parsed from comments
- `accepted_followup_without_launch`
  - follow-up was accepted recently, but no actual launch appeared

Recommended workflow:

1. Run the debug report against the broken issue.
2. Check the `Anomalies` section first.
3. If anomalies are empty, compare:
   - `apiTruth.liveRuns`
   - `apiTruth.activeRun`
   - `derivedTruth.context.pendingUserRequests`
   - `derivedTruth.conversationModel.turns`
4. If a run exists, inspect `runDiagnostics`.
5. Only after this decide whether the bug is:
   - backend truth
   - projection/documents
   - parser/model
   - renderer
