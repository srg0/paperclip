# Paperclip Incident Contour Validation Scenario

## Scenario Goal

Prove the target loop end to end:

- Atlas or Paperclip work produces a real failure signal
- Paperclip creates a separate internal incident
- the incident is routed to the correct repo
- the fix is committed and pushed from inside Paperclip
- deploy is approval-gated inside Paperclip
- deploy proof is recorded
- verification passes
- the internal incident closes

This scenario is the default acceptance script for the contour.

## Rules

- Do not fix platform incidents directly inside the external user-facing issue.
- External issue or Atlas task is a source signal only.
- Internal remediation must happen in `Paperclip Incident Contour`.
- Do not use a local developer laptop as the normal repair or deploy executor.
- If an external runner fails before the real deploy step, open a separate delivery-substrate incident instead of mixing it into the product fix.

## Preconditions

Before starting the scenario, confirm:

1. `Paperclip Incident Monitor` is active and uses deterministic `process` heartbeat.
2. `Paperclip Triage Developer` and `Paperclip Release Manager` are active.
3. The contour project has workspaces for:
   - `paperclip-control-plane`
   - `paperclip-atlas-bridge`
   - `homio/atlas`
4. Repo SSH access from Paperclip runtime is working for clone, branch, push, and MR creation.
5. Release Manager has the deploy skills and secrets allowed for the target scope.
6. Human approval phrase is known:
   - `Апрув на деплой.`
   - `Approve deploy.`
7. When you need a read-only live snapshot before or after a wave, run `node ./scripts/check-live-incident-contour-health.mjs`.
8. When you need to reconcile stale synthetic duplicates after a validation wave, run `node ./scripts/reconcile-live-incident-contour-duplicates.mjs` first in dry-run mode and then with `--apply` only for safe plans.
9. For the operator procedure around both scripts, use [paperclip-incident-contour-ops-runbook.md](/Users/s1z0v/kd-projects/paperclip-overlay/docs/paperclip-incident-contour-ops-runbook.md).

## Canonical Test Case

Use one real or synthetic failure in the Atlas execution path that belongs to one of these repos:

- `Paperclip`
- `paperclip-atlas-bridge`
- `homio/atlas`

Good examples:

- bridge launch/follow-up action breaks
- Paperclip issue projection or routing breaks
- Atlas preview or artifact-serving route breaks
- verifier result is structurally wrong
- release path fails after the fix is already ready

Avoid using a pure `homio/core` feature request for this scenario. The contour is for platform incidents around the Atlas execution path, not for normal product implementation on stands.

## Execution Steps

### Step 1. Capture source signal

Expected behavior:

- source signal appears in Atlas/Paperclip/Homio issue flow, run evidence, or runtime surface
- signal is specific enough to classify

Required evidence:

- source issue URL or id
- failing route/job/task id
- short failure summary

### Step 2. Create internal incident

Expected behavior:

- `Paperclip Incident Monitor` creates a separate issue in `Paperclip Incident Contour`
- issue gets `incident-fingerprint`
- issue stores `source-reference`
- issue is assigned to `Paperclip Triage Developer`

Pass criteria:

- no remediation chatter is written into the external source issue
- the internal issue is the working thread
- for synthetic validation sources, the source issue is closed after the internal incident reaches successful deploy + verify, so later heartbeats do not re-intake the same unchanged source signal

### Step 3. Route to the correct repo

Expected behavior:

- `Paperclip Triage Developer` reads evidence and names the owning repo
- if ownership is ambiguous, it leaves one short routing comment and resolves the ambiguity before editing

Pass criteria:

- repo decision is explicit:
  - `Paperclip`
  - `paperclip-atlas-bridge`
  - `homio/atlas`
- multi-repo fixes are split intentionally, not guessed
- if the issue is rerouted to another project workspace, the contour must schedule a follow-up wake itself; no human comment should be required just to continue in the correct repo
- if reroute happens after an old isolated execution workspace was already bound, the contour must clear the stale execution workspace binding and realize a fresh workspace for the new repo before continuing

### Step 4. Fix inside Paperclip runtime

Expected behavior:

- the agent edits the correct repo from inside a Paperclip workspace
- creates branch, commit, and push
- updates internal issue with `release-candidate`

Pass criteria:

- run context shows Paperclip workspace path
- remote branch exists
- commit sha exists
- local Mac shell is not used for the fix

### Step 5. Build release bundle

Expected behavior:

- `Paperclip Release Manager` creates or updates the deploy-scope bundle
- `bundle-plan` lists included and excluded entries
- release manager waits for manual approval

Pass criteria:

- bundle issue exists
- approval state is visible
- release manager does not deploy early

### Step 6. Approve and deploy

Expected behavior:

- human leaves approval comment
- release manager executes the deploy path from inside the contour whenever the path is available there
- if external CI is used as a rail, release manager waits for proof and records it

Pass criteria:

- deploy proof exists
- if CI runner failed before real deploy, a separate delivery-substrate incident is opened
- the product fix issue stays valid and ready
- when the reusable bundle buffer is empty after deploy, the bundle issue is moved to `backlog` and a comment explicitly says: `Буфер пуст, жду следующий аппрув на деплой.`
- if a later release-manager wake happens after proof is already recorded and the buffer is still empty, the same bundle must still be `backlog` with the idle comment (never left as stale `in_progress`)

### Step 7. Verify

Expected behavior:

- verification checks the original failure path
- verification uses the exact target named in `release-candidate`
- every scope carries an explicit `proof kind`, exact verify target, and expected restored behavior
- evidence is linked back to the internal incident
- closure is based on the repaired behavior, not on a vague "page opens"

Pass criteria:

- release evidence references the exact `post-deploy verify` target from `release-candidate`
- preview/evidence/run link exists when relevant
- the verify step names the exact target that was rerun after deploy
- verification names the exact restored behavior for that target
- release comment names exact proof kind, exact proof target, and observed restored behavior
- candidate is not closed from generic green status or pipeline-only summaries
- scope-specific target examples are enforced when relevant:
  - `paperclip-control-plane`: document/API/bundle-state target named in `release-candidate`
  - `paperclip-atlas-bridge`: packaged artifact proof plus Paperclip-side/live effect target
  - `homio/atlas`: public route/API target that originally failed

### Step 8. Close

Expected behavior:

- internal incident is moved toward done only after deploy proof and verification proof exist
- optional sync-back to the external issue is short and final

Pass criteria:

- closure comment states:
  - root cause
  - fixed repo
  - deployed commit
  - verification result

## Evidence Checklist

The scenario is not passed until all items below are present:

- source signal
- internal incident
- `incident-fingerprint`
- `source-reference`
- routing comment
- branch name
- commit sha
- push proof
- `release-candidate`
- bundle issue
- `bundle-plan`
- manual approval comment
- deploy proof
- verification proof
- closure comment

## Failure Handling

If the scenario stalls, classify the stall explicitly:

- missing repo access
- missing deploy secret
- missing workspace
- ambiguous repo ownership
- CI runner / delivery substrate failure
- verification still red after deploy

For each stall:

- comment in the internal incident
- keep ownership explicit
- create a separate delivery-substrate incident when the code fix is ready but the deploy rail is broken

## Exit Condition

The contour is accepted only when the repaired incident can be traced entirely through Paperclip-native evidence from detection to closure, without switching the main repair path to a local developer machine.
