// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent, Issue, IssueDocument } from "@paperclipai/shared";
import {
  buildIssueExecutionHeaderModel,
  derivePendingAtlasFollowupStatusFromCommentContext,
  buildPendingAtlasFollowupStatus,
  parseExecutionDocument,
  shouldUsePendingAtlasLiveSignal,
} from "./issue-execution-flow";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-delivery",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "HOM-553",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-15T02:00:00.000Z"),
    updatedAt: new Date("2026-04-15T02:05:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

function makeAgent(id: string, name: string, urlKey: string): Agent {
  return {
    id,
    companyId: "company-1",
    name,
    urlKey,
    role: name,
    adapterType: "codex",
    model: null,
    icon: name.slice(0, 1),
    systemPrompt: null,
    instructions: null,
    description: null,
    isArchived: false,
    isDisabled: false,
    isSystem: false,
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
  } as unknown as Agent;
}

function makeExecutionDocument(body: string): IssueDocument {
  return {
    id: "doc-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "atlas-execution",
    title: "Сводка выполнения Atlas",
    format: "markdown",
    body,
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T02:05:17.267Z"),
  };
}

describe("buildIssueExecutionHeaderModel", () => {
  it("prefers the latest execution document over stale assignee ownership when auto-review is blocked", () => {
    const model = buildIssueExecutionHeaderModel({
      issue: makeIssue(),
      executionDocument: makeExecutionDocument(`# Сводка выполнения Atlas

Проверка завершена, но auto-review заблокирован

## Что произошло

- Следующий шаг: Нужен сценарный или assertion-driven verify по последнему запросу.
- Проверка: \`passed\`
- Turn: \`TURN 2\`

## Последние этапы

- **Atlas Executor** — TURN 2 взят в работу: Исполнение идет в слоте ai04. (2026-04-15 02:00:11)
- **Stand Controller** — Результат опубликован и доступен: Открой https://ai04.homio.pro. (2026-04-15 02:03:53)
- **Technical Verifier** — Проверка недостаточна для auto-review: VerifyReport зеленый, но слишком общий. (2026-04-15 02:03:53)
- **Reporter** — Автопринятие заблокировано: Execution завершен, но verify не доказал выполнение последнего запроса. (2026-04-15 02:03:53)

## Техническая привязка

- Execution state: \`completed\`
- Attachment state: \`attached\`
- Projection updated: \`2026-04-15T02:05:17.248Z\``),
      linkedRuns: [],
      liveRuns: [],
      activeRun: null,
      activity: [],
      agents: [
        makeAgent("agent-delivery", "Delivery Orchestrator", "delivery-orchestrator"),
        makeAgent("agent-reporter", "Reporter", "reporter"),
      ],
    });

    expect(model.currentAgent).toBe("Delivery Orchestrator");
    expect(model.stages.find((stage) => stage.key === "report")?.state).toBe("blocked");
    expect(model.stages.find((stage) => stage.key === "atlas_execute")?.state).toBe("passed");
    expect(model.stages.find((stage) => stage.key === "stand_apply")?.state).toBe("passed");
    expect(model.stages.find((stage) => stage.key === "verify")?.state).toBe("passed");
  });

  it("does not surface success-like failureClass values as an error state", () => {
    const model = buildIssueExecutionHeaderModel({
      issue: makeIssue({ status: "in_review" }),
      executionDocument: makeExecutionDocument(`# Сводка выполнения Atlas

Подтверждено: сценарий прошёл.

## Что произошло

- Проверка: \`passed\`
- Turn: \`TURN 1\`

## Техническая привязка

- Execution state: \`completed\`
- Failure class: \`passed\`
- Projection updated: \`2026-04-15T02:05:17.248Z\``),
      linkedRuns: [],
      liveRuns: [],
      activeRun: null,
      activity: [],
      agents: [
        makeAgent("agent-delivery", "Delivery Orchestrator", "delivery-orchestrator"),
        makeAgent("agent-reporter", "Reporter", "reporter"),
      ],
    });

    expect(model.flowSeverity).not.toBe("error");
    expect(model.mismatchText).toBeNull();
    expect(model.stages.find((stage) => stage.key === "report")?.state).toBe("passed");
  });
});

describe("buildPendingAtlasFollowupStatus", () => {
  it("stays pending until Atlas updates the execution projection after the new comment", () => {
    const parsed = parseExecutionDocument(makeExecutionDocument(`# Сводка выполнения Atlas

Проверка завершена и требует внимания

## Что произошло

* Задача: TURN 2
* Статус: \`in_progress\`

## Техническая привязка

* Execution state: \`failed\`
* Projection updated: \`2026-04-15T11:15:55.834Z\``));

    const status = buildPendingAtlasFollowupStatus({
      pendingSince: "2026-04-15T11:16:10.000Z",
      baseTurnNumber: 2,
      parsed,
    });

    expect(status.state).toBe("pending");
    expect(status.title).toBe("Thinking");
    expect(status.detail).toBeNull();
  });

  it("surfaces a running follow-up turn once the projection advances", () => {
    const parsed = parseExecutionDocument(makeExecutionDocument(`# Сводка выполнения Atlas

Исполнение уже началось

## Что произошло

- Turn: \`TURN 3\`
- Статус: \`in_progress\`

## Техническая привязка

- Execution state: \`running\`
- Attachment state: \`unattached\`
- Projection updated: \`2026-04-15T11:16:15.000Z\``));

    const status = buildPendingAtlasFollowupStatus({
      pendingSince: "2026-04-15T11:16:10.000Z",
      baseTurnNumber: 2,
      parsed,
    });

    expect(status.state).toBe("running");
    expect(status.title).toBe("Running");
    expect(status.summary).toBe("TURN 3");
    expect(status.detail).toBeNull();
  });

  it("surfaces a blocked dispatch immediately even before projection catches up", () => {
    const parsed = parseExecutionDocument(makeExecutionDocument(`# Сводка выполнения Atlas

Проекция ещё не обновилась

## Что произошло

- Turn: \`TURN 2\`
- Статус: \`in_review\`

## Техническая привязка

- Execution state: \`completed\`
- Projection updated: \`2026-04-15T11:15:55.834Z\``));

    const status = buildPendingAtlasFollowupStatus({
      pendingSince: "2026-04-15T11:16:10.000Z",
      baseTurnNumber: 2,
      parsed,
      dispatch: {
        status: "blocked",
        requestType: "followup",
        detail: "Atlas bridge worker is not running.",
        turnNumber: 3,
        turnLabel: "TURN 3",
      },
    });

    expect(status.state).toBe("blocked");
    expect(status.title).toBe("Blocked");
    expect(status.summary).toContain("Atlas bridge worker is not running");
  });

  it("prefers the live transport state over a stale projection snapshot", () => {
    const parsed = parseExecutionDocument(makeExecutionDocument(`# Сводка выполнения Atlas

Проекция ещё не догнала follow-up

## Что произошло

- Turn: \`TURN 2\`
- Статус: \`in_review\`

## Техническая привязка

- Execution state: \`completed\`
- Projection updated: \`2026-04-15T11:15:55.834Z\``));

    const status = buildPendingAtlasFollowupStatus({
      pendingSince: "2026-04-15T11:16:10.000Z",
      baseTurnNumber: 2,
      parsed,
      dispatch: {
        status: "accepted",
        requestType: "followup",
        detail: "Atlas accepted the follow-up.",
        turnNumber: 3,
        turnLabel: "TURN 3",
      },
      live: {
        state: "queued",
        title: "Starting",
        summary: "Atlas Executor",
        detail: null,
        turnLabel: "TURN 3",
      },
    });

    expect(status.state).toBe("queued");
    expect(status.title).toBe("Starting");
    expect(status.turnLabel).toBe("TURN 3");
  });
});

describe("derivePendingAtlasFollowupStatusFromCommentContext", () => {
  it("restores an accepted-thinking state from durable pending conversation after reload", () => {
    const status = derivePendingAtlasFollowupStatusFromCommentContext({
      latestExecutedTurn: {
        sequence: 10,
        request: "предыдущий turn",
        events: [],
        status: "settled",
        startedAt: "2026-04-22T18:00:00.000Z",
        settledAt: "2026-04-22T18:01:00.000Z",
        latestCommentId: null,
        standUrl: null,
        evidenceUrl: null,
        verifierScope: null,
        outcome: null,
      },
      pendingUserRequests: ["[pw] Ответь сюда же коротким ack и начни новый follow-up turn."],
      pendingConversation: [
        {
          id: "pending-user-1",
          speaker: "user",
          body: "[pw] Ответь сюда же коротким ack и начни новый follow-up turn.",
          createdAt: "2026-04-22T18:12:01.214Z",
          tone: "info",
        },
        {
          id: "pending-assistant-1",
          speaker: "assistant",
          body: "Принял follow-up. Это Atlas Executor.",
          createdAt: "2026-04-22T18:12:11.000Z",
          tone: "working",
        },
      ],
    });

    expect(status).not.toBeNull();
    expect(status?.state).toBe("accepted");
    expect(status?.title).toBe("Thinking");
    expect(status?.summary).toBe("Atlas Executor");
    expect(status?.turnLabel).toBe("TURN 11");
  });

  it("shows waiting when a follow-up user message exists but Atlas has not acked yet", () => {
    const status = derivePendingAtlasFollowupStatusFromCommentContext({
      latestExecutedTurn: {
        sequence: 4,
        request: "предыдущий turn",
        events: [],
        status: "settled",
        startedAt: "2026-04-22T17:00:00.000Z",
        settledAt: "2026-04-22T17:01:00.000Z",
        latestCommentId: null,
        standUrl: null,
        evidenceUrl: null,
        verifierScope: null,
        outcome: null,
      },
      pendingUserRequests: ["новый follow-up"],
      pendingConversation: [
        {
          id: "pending-user-2",
          speaker: "user",
          body: "новый follow-up",
          createdAt: "2026-04-22T18:15:00.000Z",
          tone: "info",
        },
      ],
    });

    expect(status).not.toBeNull();
    expect(status?.state).toBe("pending");
    expect(status?.title).toBe("Thinking");
    expect(status?.summary).toBe("Atlas Executor");
    expect(status?.turnLabel).toBe("TURN 5");
  });
});

describe("shouldUsePendingAtlasLiveSignal", () => {
  it("drops stale running websocket signals when there is no live run and no pending follow-up", () => {
    expect(shouldUsePendingAtlasLiveSignal({
      signal: {
        state: "running",
        title: "Running",
        summary: "TURN 5",
        detail: null,
        turnLabel: "TURN 5",
        updatedAt: "2026-04-15T11:15:00.000Z",
      },
      hasLiveRun: false,
      hasPendingFollowup: false,
      now: new Date("2026-04-15T11:15:20.500Z").getTime(),
    })).toBe(false);
  });

  it("keeps websocket signals while a live run is still active", () => {
    expect(shouldUsePendingAtlasLiveSignal({
      signal: {
        state: "running",
        title: "Running",
        summary: "TURN 5",
        detail: null,
        turnLabel: "TURN 5",
        updatedAt: "2026-04-15T11:15:00.000Z",
      },
      hasLiveRun: true,
      hasPendingFollowup: false,
      now: new Date("2026-04-15T11:25:00.000Z").getTime(),
    })).toBe(true);
  });
});

describe("parseExecutionDocument", () => {
  it("parses star-bullet atlas execution documents and legacy milestone headings", () => {
    const parsed = parseExecutionDocument(makeExecutionDocument(`# Итог выполнения Atlas

Подтверждено: сценарий «Project layouts surface regression» прошёл.

## Текущее состояние

* Задача: TURN 1
* Состояние проверки: Все обязательные критерии подтверждены., TURN 1 завершился зелёной проверкой, evidence уже опубликован.
* Статус сценария: \`passed\`
* Turn: \`TURN 1\`
* Следующий шаг: Открой стенд и проверь UI вручную.

## Наблюдения verifier

* Класс сценария: project_layouts_surface
* Сценарий: Project layouts surface regression

## Что делать дальше

* Evidence: https://atlas.homio.pro/app/output/example.png

## Изменения и diff

* Исполнитель зафиксировал: Сделал точечное улучшение fullscreen-галереи.

Ограничения проверки:

* Нужна ручная проверка в UI для жестов и double tap.

## Как шёл turn

* **Atlas Executor** — TURN 1 взят в работу: Исполнение уже началось. (2026-04-17 10:08:34)
* **Technical Verifier** — Проверка пройдена: Подтверждено: сценарий «Project layouts surface regression» прошёл. (2026-04-17 10:16:23)`));

    expect(parsed.currentState).toContain("Все обязательные критерии подтверждены");
    expect(parsed.nextStep).toContain("Открой стенд");
    expect(parsed.scenarioStatus).toBe("passed");
    expect(parsed.turnLabel).toBe("TURN 1");
    expect(parsed.evidenceUrl).toContain("/app/output/example.png");
    expect(parsed.executorSummary).toContain("fullscreen");
    expect(parsed.verifierScope).toBe("Project layouts surface regression");
    expect(parsed.verificationLimitations[0]).toContain("double tap");
    expect(parsed.measuredObservations).toContain("Класс сценария: project_layouts_surface");
    expect(parsed.rawBody).toContain("Как шёл turn");
    expect(parsed.recentMilestones).toHaveLength(2);
    expect(parsed.recentMilestones[0]?.role).toBe("Atlas Executor");
  });
});
