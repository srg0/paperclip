# Issue Chat Live Transport

## Goal

Make the issue chat feel immediate like Codex Desktop:

- the user sends one message in the issue chat
- the system acknowledges it instantly
- the same surface starts showing `accepted`, `queued`, `running`, `completed`, `failed`, or `blocked`
- execution detail is streamed into the chat without forcing the user to infer state from stale review lifecycle transitions

This transport must stay compatible with the Paperclip control plane and must not bypass orchestration, skill routing, or durable issue history.

## Non-goals

- do not create a second backend websocket server
- do not replace durable issue comments with ephemeral stream tokens
- do not collapse all agent contexts into one shared raw prompt buffer
- do not let optimistic chat text overwrite proof, verify, or reporter truth

## Core Architecture

The live issue chat is split into four layers:

1. `issue comments`
   Durable human-visible messages. This is the audit trail.

2. `followup dispatch`
   A command layer created when a new issue comment should produce a new execution turn.

3. `live event stream`
   Ephemeral realtime updates over the existing company websocket.

4. `proof + artifacts`
   Durable execution outputs, verifier outputs, and documents that define closure truth.

These layers must stay separate.

## Transport Rule

Use the existing company websocket:

- server endpoint: `/api/companies/:companyId/events/ws`
- event publisher: `server/src/services/live-events.ts`

Do not add a second websocket backend just for issue chat.

The issue chat should consume the same live bus and normalize a scoped subset of events into user-facing chat signals.

## Current Event Mapping

The issue chat normalizes these events:

- `activity.logged`
  - `issue.followup_requested` -> `accepted`
  - `issue.followup_blocked` -> `blocked`
  - `issue.comment_added` from `actorType=agent` -> feed item in chat

- `heartbeat.run.queued`
  - matching `issueId` -> `queued`

- `heartbeat.run.status`
  - matching `issueId`
  - `running` -> `running`
  - `succeeded` -> `completed`
  - `failed|timed_out|cancelled` -> `failed`

- `heartbeat.run.event`
  - matching `issueId` -> compact live feed entries

## Issue Correlation Contract

Realtime events that belong to an issue must carry `issueId` in their payload when possible.

For heartbeat-based lifecycle events, this correlation is derived from the run context snapshot:

- `contextSnapshot.issueId`
- fallback: `contextSnapshot.taskId`

The chat layer matches both:

- internal issue UUID
- human issue identifier such as `HOM-957`

## Multi-Agent Model

The chat surface is unified, but agents keep their own execution contexts.

The model is:

- one issue chat thread
- many agent-local execution contexts
- one transport stream

Each agent may emit live updates into the same thread, but those updates must be tagged by agent identity and turn lineage.

This means:

- `Atlas Executor` can stream execution state
- `Delivery Orchestrator` can acknowledge dispatch or handoff
- `Business Analyst` can reply in the same chat later

But each one keeps its own internal prompt/runtime context.

The issue chat is the shared conversation envelope, not the shared raw model memory.

## Truth Priority

Order of trust:

1. proof/artifacts/documents
2. durable execution lifecycle state
3. live stream events
4. optimistic local UI state

The live stream is intentionally fast, but it is not allowed to become the final proof source.

## Current Local Implementation

Local changes in this wave add:

- direct follow-up dispatch acknowledgement from the issue comment API
- suppression of the stale generic wakeup path when direct follow-up already succeeded or blocked
- issue-aware heartbeat live events by including `issueId` in queued/status/event/log payloads
- a page-scoped issue chat live hook
- instant pending banners and compact live feed rows in the issue conversation surface

## Why Page-Scoped Subscription First

The current implementation opens the websocket only while the issue chat page is mounted.

This keeps the blast radius small and matches the desired UX:

- keep the transport active while the user is watching the chat
- avoid turning the whole app into a mandatory always-on stream consumer for this first step

Later this can be consolidated into the global `LiveUpdatesProvider` if we want one shared socket fan-out.

## Next Steps

1. Move issue-chat event fan-out into `LiveUpdatesProvider` so the app uses one company socket per company session.
2. Add explicit `turn_started`, `turn_attached`, and `turn_failed_before_attach` normalized signals.
3. Stream agent-authored partial status messages into the same feed with replay-safe keys.
4. Add a server-side `followup_request` model so command dispatch is durable and idempotent.
5. Add explicit multi-agent reply routing so a user can target `Business Analyst`, `Delivery Orchestrator`, or `Atlas Executor` inside the same chat without mixing runtime contexts.
