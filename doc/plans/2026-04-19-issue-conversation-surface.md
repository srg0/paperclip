# 2026-04-19 Issue Conversation Surface

## Goal

Move the issue execution UX closer to Codex desktop by making the conversation the default surface, collapsing raw execution noise, and relocating controls/debug details into a separate task dashboard.

## Implemented

- Added a turn-first issue conversation model in `ui/src/lib/issue-conversation-model.ts`.
- Added a Codex-style main surface in `ui/src/components/issue-conversation/IssueConversationSurface.tsx`.
- Added a dedicated composer in `ui/src/components/issue-conversation/IssueConversationComposer.tsx`.
- Added slash palette coverage for:
  - `/mr` as an existing merge-request intent on the normal issue comment path
  - `/cancel` as an interrupt comment with the existing `interrupt` API flag
  - `/reopen`, `/mention`, `/attach` as composer-level control actions over existing UI state
- Split `IssueDetail` into:
  - `Conversation` as the default task-facing mode
  - `Task Dashboard` for live sessions, documents, attachments, activity, raw history, and plugin tabs
- Added a stable UX fixture page at `/tests/ux/issues`.
- Added browser smoke coverage in `tests/e2e/issue-conversation-ux.spec.ts`.

## Product Rules

- The main issue flow must prioritize task narrative over raw role-by-role operational chatter.
- Live activity may stay visible, but it should be summarized into bundles instead of flooding the main thread.
- Durable proof should be visually distinct from live preview/debug links.
- Slash palette entries must be honest about their behavior:
  - true task commands may submit or interrupt
  - helper entries may configure the composer without pretending to be backend slash parsing

## Verification

Verified locally on 2026-04-19 with:

```sh
pnpm -r typecheck
pnpm exec playwright test tests/e2e/issue-conversation-ux.spec.ts --config tests/e2e/playwright.config.ts
pnpm build
```

Generated screenshots in:

- `output/playwright/issue-conversation-overview.png`
- `output/playwright/issue-conversation-slash-palette.png`
- `output/playwright/issue-conversation-brief-running.png`
- `output/playwright/issue-conversation-debug-failed.png`

## Known Repo Baseline Issues

`pnpm test:run` currently fails outside this UI slice because of existing server test breakage in:

- `server/src/__tests__/agent-permissions-routes.test.ts`
- `server/src/__tests__/agent-skills-routes.test.ts`
- `server/src/__tests__/company-branding-route.test.ts`

Those failures reference `documentService` mock coverage and branding route expectations, not the issue conversation UI.
