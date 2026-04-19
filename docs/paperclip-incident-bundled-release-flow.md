# Paperclip Incident Bundled Release Flow

## Companion Docs

Read together with:

- `docs/paperclip-incident-contour-architecture.md`
- `docs/paperclip-incident-contour-validation-scenario.md`
- `docs/paperclip-incident-contour-five-incident-pack.md`
- `docs/paperclip-multirepo-internal-project.md`
- `../paperclip-atlas-bridge/docs/paperclip-incident-contour-bridge-contract.md`
- `../Homio/atlas/docs/paperclip-incident-contour-atlas-contract.md`

## Goal

Make Paperclip itself the control plane for:

- detecting failures
- opening actionable incident tasks
- fixing one bug at a time
- buffering ready fixes into a controlled release bundle
- waiting for manual approval before deploy
- deploying only the approved bundle contents

## Why this shape

The important split is:

- bug fixing is per-issue and per-commit
- deployment is per-bundle and approval-gated
- external source tasks stay read-only signal sources; remediation lives in separate internal Paperclip issues

That keeps root-cause tracking clean without forcing one deploy per bug.

## Roles

### `Paperclip Incident Monitor`

- deterministic first-pass heartbeat
- checks incident surfaces without LLM by default
- deduplicates by fingerprint
- creates incident issues only when a concrete red flag is present
- keeps external source tasks as references, not as the remediation thread
- creates a parent `incident wave` issue only when one scan finds multiple distinct failures

### `Paperclip Triage Developer`

- owns diagnosis and code changes
- selects the correct repo
- fixes one bug per branch/commit
- prepares `release-candidate` document
- runs natively through `codex_local` inside Paperclip, not through the Atlas adapter
- treats external tasks as evidence only unless a human explicitly asks to post back

### `Paperclip Release Manager`

- aggregates ready candidates by deploy scope
- keeps one open release bundle issue per scope
- waits for explicit manual approval comment
- deploys only approved entries
- prefers deploy execution from inside the Paperclip contour itself
- treats GitLab pipelines as secondary delivery rails and audit evidence, not as the only legal deploy executor

Important boundary:

- this release flow is for internal platform remediation in `Paperclip`, `paperclip-atlas-bridge`, and `homio/atlas`
- it does not replace the normal Atlas execution chain for `homio/core` delivery on AI stands

## Error counting and buffering

### How to decide whether there is one error or many

Use distinct fingerprints, not raw event count.

One error means:

- same surface
- same service
- same failure class
- same route, job, or operation family

Many errors means:

- different failure class, or
- different service, or
- different route/job family, or
- one scan clearly shows multiple unrelated breakages

Example:

- five copies of the same bridge `git_push_failed` event are one incident
- one `paperclip /api/issues 500` and one `atlas dispatcher deploy failed` are two incidents

### Where the buffer lives

The buffer lives in Paperclip issues and documents:

- each bug fix stays as its own issue
- each fix writes `release-candidate`
- each deploy scope gets one open bundle issue with `bundle-plan`
- each external source task is referenced from the internal issue, not reused as the fix thread

No external spreadsheet or hidden queue is needed.

## Cheap monitoring mode

The preferred runtime for `Paperclip Incident Monitor` is a deterministic `process` adapter, not a full `codex_local` loop.

Use this split:

- deterministic prefilter every few minutes:
  - public health endpoint
  - selected agent error states
  - explicit route or webhook failures
- existing incident evidence refresh without ownership rollback
- Codex-native triage only after a real red flag is found

This keeps:

- near-zero token burn when the system is healthy
- native Paperclip audit trail
- the expensive LLM path reserved for actual repair work

If richer external signals are available, prefer webhook-triggered routines or plugin webhooks over timer-based LLM polling.

## External signal handling

When the trigger comes from an external tracker such as Homio, Atlas, Bitrix, GitLab, or Sentry:

- create a separate internal issue in `Paperclip Incident Contour`
- store the external source URL or id in the internal issue description and documents
- keep diagnosis, branch updates, release notes, and deploy gating inside the internal issue
- do not flood the external task with remediation chatter
- only post back to the external task when a human explicitly asks for a sync comment or when the final outcome must be mirrored

Recommended internal issue payload:

- concise Russian title for the actual failure
- source reference line with the external task URL or id
- stable `incident-fingerprint`
- evidence summary and repro hint
- repo routing decision once triage confirms the owner
- if the incident already progressed to release, monitor updates must touch documents only and must not reassign the issue back to triage

## Fix ordering

Default ordering:

1. production outage
2. deploy blocker
3. user-visible regression
4. repeated noise

Within the same priority:

- oldest first
- then by smallest safe fix first if it unblocks the rest

## Approval model

Current Paperclip built-in approvals are not deploy-specific.

Built-in approval types today are:

- `hire_agent`
- `approve_ceo_strategy`
- `budget_override_required`

So for deploy gating the safe current model is:

- explicit human or board comment on the bundle issue
- Release Manager reacts only to exact approval phrases

Approval comments:

- `Апрув на деплой.`
- `Approve deploy.`

Reject comments:

- `Отклоняю bundle.`
- `Reject bundle.`

This keeps audit trail inside Paperclip without abusing unrelated approval types.

## Deploy behavior

### If exactly one issue is ready

- Release Manager creates a single-entry bundle issue
- asks for approval immediately
- after approval, deploys that one entry

### If multiple issues are ready

- Release Manager updates the open bundle issue for that scope
- records all included and excluded entries in `bundle-plan`
- waits until the human resolves the bundle contents
- deploys only after accepted/rejected entries are clear

## Reusable Bundle Idle Contract

After a successful deploy when no approved entries remain in the current scope:

- keep the same bundle issue open for reuse
- switch bundle issue status to `backlog` (idle waiting state)
- add a comment that explicitly states idle buffer state:
  - `Буфер пуст, жду следующий аппрув на деплой.`
- do not keep the reusable bundle issue in `in_progress` when the buffer is empty
- on any later heartbeat, if deploy proof already exists and the scope buffer is still empty, normalize the issue to the same idle state immediately (do not keep `in_progress` just because no new deploy step ran in this turn)

## Contour-native deploy rule

The intended remediation loop is:

- incident detection inside Paperclip
- code fixing inside Paperclip
- release approval inside Paperclip
- deploy execution inside Paperclip

GitLab pipelines may still be used, but they are not the architectural center of the remediation loop.

Practical rule:

- if the repo-native deploy script can run from the Paperclip contour with the required credentials, use that as the primary path
- if an external CI runner fails before the actual deploy step because of runner reachability or runner-local secret drift, record it as a separate delivery-substrate incident
- do not switch to a developer laptop as the normal recovery path
- keep the bundle open and let `Paperclip Release Manager` continue through the in-contour path when approval already exists
- for every scope, the `release-candidate` must name the exact post-deploy verify target, the `proof kind`, and the restored behavior that must be observed before closure
- release proof is not complete on a generic green deploy; it is complete only when that exact verify target is rerun and recorded

## Post-deploy self-verify contract

For every approved candidate, Release Manager must verify against the exact `post-deploy verify target` from `release-candidate` and comment the exact restored behavior.

Do not close a candidate on a generic green pipeline summary.

Scope-specific requirements:

- `paperclip-control-plane`: verify the exact document, authenticated API call, or bundle-state target named in `release-candidate`
- `paperclip-atlas-bridge`: verify both the packaged artifact tuple and the exact Paperclip-side or live-effect target named in `release-candidate`
- `homio/atlas`: verify the exact public route or API target that originally failed

Required candidate comment after self-verify:

- exact proof kind
- exact proof target
- observed restored behavior

## Recommended project shape

Use one project with workspaces for:

- `paperclip-control-plane`
- `paperclip-atlas-bridge`
- `homio/atlas`

That keeps:

- one audit surface
- repo-aware execution
- one place for Codex-native incident and release issues

Important boundary:

- this project does not replace the existing Homio/Atlas stand execution flow
- it complements it
- use it for Codex-native repo fixing and release control inside Paperclip
- keep Homio project execution through Atlas where Atlas is the actual worker/runtime

## Minimal live rollout

1. Create the multi-repo Paperclip project.
2. Hire:
   - `Paperclip Incident Monitor`
   - `Paperclip Triage Developer`
   - `Paperclip Release Manager`
3. Approve the hires.
4. Start with manual approval comments on bundle issues.
5. Only after this is stable, consider adding a native deploy-approval type upstream.
