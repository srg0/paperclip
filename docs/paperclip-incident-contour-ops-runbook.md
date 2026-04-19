# Paperclip Incident Contour Ops Runbook

## Goal

Keep the `Paperclip Incident Contour` healthy without touching live state blindly.

Use this runbook for:

- checking whether the deterministic monitor is alive
- checking whether stale duplicate synthetic incidents accumulated
- reconciling only safe duplicate tails
- proving what is live on `dev-cnt-pcl01` before and after a validation wave

## Read-Only Health Snapshot

Use the health probe first.

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
node ./scripts/check-live-incident-contour-health.mjs --summary
```

For the full JSON snapshot:

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
node ./scripts/check-live-incident-contour-health.mjs
```

Useful switches:

- `--fail-on-violations`: exit `2` when blocking violations exist
- `--fail-on-historical`: treat historical duplicate groups as blocking too
- `--fingerprint synthetic-source-signal:HOM-858`: inspect one duplicate family only

Health probe also reports the live prefilter artifact metadata:

- path
- sha256
- mtime
- size

That makes it easier to prove the runtime on `dev-cnt-pcl01` actually carries the expected dedupe fix.

Health probe also reports basic bundle readiness markers per release bundle:

- `hasBundlePlan`
- `hasDeployApproval`
- `hasIdleComment`

## Duplicate Reconciliation

Dry-run first:

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
node ./scripts/reconcile-live-incident-contour-duplicates.mjs
```

Scope one family only:

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
node ./scripts/reconcile-live-incident-contour-duplicates.mjs \
  --fingerprint synthetic-source-signal:HOM-858
```

Limit the number of safe plans:

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
node ./scripts/reconcile-live-incident-contour-duplicates.mjs --limit 1
```

Apply only after checking the dry-run output:

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
node ./scripts/reconcile-live-incident-contour-duplicates.mjs --apply
```

Dry-run output now explains:

- `canonicalReason`
- per-duplicate `reconcileReason`

Use that explanation before any `--apply`.

## Safe Reconciliation Contract

Auto-cancel is allowed only when all conditions hold:

- duplicate belongs to a synthetic fingerprint family
- a sibling in the same family is already `done`
- duplicate itself is not already terminal
- duplicate does not carry a meaningful unique `release-candidate`

Meaningful candidate means:

- non-empty candidate preview
- not `branch: main`
- not `no new branch changes required`
- not `verification-only`

If a duplicate still carries a meaningful candidate, it must stay in `manualReview`, not be auto-cancelled.

## Post-Apply Check

After reconciliation:

```bash
cd /Users/s1z0v/kd-projects/paperclip-overlay
node ./scripts/check-live-incident-contour-health.mjs --fail-on-violations
```

Expected result:

- exit code `0`
- no `synthetic-duplicate-active`

Historical duplicates may still remain for audit purposes unless you also require `--fail-on-historical`.
