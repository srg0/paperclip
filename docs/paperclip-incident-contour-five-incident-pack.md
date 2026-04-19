# Paperclip Incident Contour Five-Incident Pack

This pack defines five controlled validation incidents for the contour.

Use it to prove:

- source signal intake
- internal incident creation
- repo routing
- Paperclip-native code change
- release bundle and approval gate
- deploy proof
- post-deploy self-verify
- closure

Rules:

- all source issues use the synthetic validation prefix
- each source issue is assigned to one Atlas-path stream agent for provenance
- remediation still happens only in `Paperclip Incident Contour`
- each incident must carry an explicit `Post-deploy verify` contract in the source description
- monitor refreshes on an existing internal incident must preserve the current assignee once the issue left initial triage ownership
- after a successful synthetic validation wave, the synthetic source issue must be closed so the deterministic monitor does not create a second internal incident from the same unchanged source
- a completed synthetic internal incident must still count as the canonical fingerprint owner for that source; later heartbeats must not open a duplicate unless the source contract itself changed materially
- extra Atlas-path comments, debug-pack writes, or other source-task churn after the contour fix is complete do not count as a material change for synthetic dedupe

Validation pack:

1. `delivery-orchestrator / paperclip-control-plane / bundle-idle-state`
   - failure class: reusable bundle stays active instead of idle-waiting after deploy
   - expected proof: bundle comment + final status show empty buffer and waiting-for-next-approval shape (`backlog` idle state, not stale `in_progress`)

2. `atlas-executor / paperclip-control-plane / self-verify-contract`
   - failure class: release contract for non-Atlas scopes is too vague
   - expected proof: release prompt/doc behavior names exact proof target instead of a generic green summary

3. `technical-verifier / homio/atlas / malformed-a2a-task-route`
   - failure class: malformed A2A task path returns `500 URI malformed`
   - expected proof: target routes return `400` or `404`, not `500`
   - note: `POST /api/a2a/tasks/%ZZ/status` must be checked with a valid JSON payload such as `{"status":"submitted"}` so the proof isolates malformed-id handling rather than body validation

4. `reporter / homio/atlas / malformed-runtime-work-thread-route`
   - failure class: malformed runtime work-thread path returns `500 URI malformed`
   - expected proof: target route returns `400` or `404`, not `500`

5. `stand-controller / paperclip-atlas-bridge / bridge-self-verify-contract`
   - failure class: bridge release contract lacks an exact post-deploy self-verify step
   - expected proof: contract doc requires packaged artifact proof plus Paperclip-side/live effect proof

The controlled source issue body should include:

- `Owning repo`
- `Failure class`
- `Expected failure`
- `Allowed change surface`
- `Repro`
- `Post-deploy verify`
- `Closure rule`

The default runner for this pack is `scripts/run-incident-contour-validation-pack.mjs`.
