// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { buildIssueExecutionCommentContext, buildIssueNarrativeChatMessages } from "./issue-execution-turns";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Fullscreen gallery improvements",
    description: "Сделай fullscreen gallery удобной для телефона и компьютера.",
    status: "in_review",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "HOM-638",
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
    createdAt: new Date("2026-04-16T12:00:00.000Z"),
    updatedAt: new Date("2026-04-17T15:08:27.380Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

function makeComment(body: string, createdAt: string, user = false): IssueComment {
  return {
    id: createdAt,
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: user ? null : "agent-1",
    authorUserId: user ? "user-1" : null,
    body,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

describe("buildIssueExecutionCommentContext", () => {
  it("derives executed turns from comment history and flags newer user comments after the last execution", () => {
    const context = buildIssueExecutionCommentContext({
      issue: makeIssue(),
      projectedTurnNumber: 1,
      comments: [
        makeComment("Добавь активацию по двойному тапу", "2026-04-16T13:47:28.574Z", true),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Delivery Orchestrator -->
### Delivery Orchestrator

**Запрос принят**

Задачу разобрал и передаю ее в Atlas на execution.`, "2026-04-17T12:29:47.523Z"),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Atlas Executor -->
### Atlas Executor

**Execution запущен**

Atlas принял turn и поднимает workspace для этой задачи.`, "2026-04-17T12:29:55.174Z"),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Technical Verifier -->
### Technical Verifier

**Проверка пройдена**

- Что проверено: Подтверждено: сценарий «Project media surface regression» прошёл.
- Стенд: https://ai01.homio.pro
- Evidence: https://atlas.homio.pro/app/output/example.png`, "2026-04-17T12:39:30.635Z"),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Reporter -->
### Reporter

**Итог готов для проверки человеком**

**Коротко:** Все ожидаемые изменения доступны на стенде и готовы к human review.`, "2026-04-17T12:39:35.455Z"),
        makeComment("Добавил активацию по двойному тапу?", "2026-04-17T13:42:59.532Z", true),
        makeComment("норм делай mr", "2026-04-17T15:08:22.950Z", true),
      ],
    });

    expect(context.turns).toHaveLength(2);
    expect(context.latestExecutedTurn?.sequence).toBe(2);
    expect(context.latestExecutedTurn?.request).toBe("Добавь активацию по двойному тапу");
    expect(context.latestExecutedTurn?.verifierScope).toContain("Project media surface regression");
    expect(context.pendingUserRequests).toEqual([
      "Добавил активацию по двойному тапу?",
      "норм делай mr",
    ]);
    expect(context.projectionWarning).toContain("новые user comments");
  });

  it("uses explicit TURN markers from bridge comments so late comments do not collapse back to Turn 1", () => {
    const context = buildIssueExecutionCommentContext({
      issue: makeIssue({
        identifier: "HOM-957",
        title: "Добавляем HyperFrames в управление контентом",
        description: "Сделай HyperFrames рабочим в create social post.",
      }),
      projectedTurnNumber: 4,
      comments: [
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Stand Controller -->
### Stand Controller

**Стенд обновлен**

- Текущий turn: \`TURN 1\`
- Стенд: https://ai01.homio.pro`, "2026-04-20T04:41:19.228Z"),
        makeComment("Статус: запускаю новую чистую волну по HyperFrames.", "2026-04-20T06:30:12.974Z", true),
        makeComment("Статус: продуктовый turn остановлен как platform incident.", "2026-04-20T06:39:20.946Z", true),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Stand Controller -->
### Stand Controller

**Стенд обновлен**

- Текущий turn: \`TURN 3\`
- Стенд: https://ai01.homio.pro`, "2026-04-20T07:06:22.610Z"),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Technical Verifier -->
### Technical Verifier

**Проверка пройдена**

- TURN 3 дошёл до стадии technical verify`, "2026-04-20T07:06:22.654Z"),
        makeComment("Статус: запускаю новую execution wave после structural fixes.", "2026-04-20T09:16:12.956Z", true),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Technical Verifier -->
### Technical Verifier

**Проверка пройдена**

- TURN 4 дошёл до стадии technical verify`, "2026-04-20T09:29:51.063Z"),
        makeComment("Проверь сам через Бэк и пришли ссылку на видео и фото сюда в чат для проверки", "2026-04-20T11:29:49.586Z", true),
        makeComment("Проверь сам через Бэк и пришли ссылку на видео и фото сюда в чат для проверки", "2026-04-20T11:30:24.782Z", true),
        makeComment("Статус: возвращаю задачу в активный execution turn по прямому follow-up пользователя.", "2026-04-20T16:14:28.536Z", true),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Reporter -->
### Reporter

**Итог готов для проверки человеком**

**Коротко:** Прошли 5 итераций правок.

- Turn: \`TURN 5\``, "2026-04-20T16:26:49.827Z"),
        makeComment("Статус: запускаю новую execution wave после structural fixes.", "2026-04-20T16:31:44.544Z", true),
        makeComment(`<!-- paperclip-display-author: Atlas Bridge · Technical Verifier -->
### Technical Verifier

**Проверка не прошла**

- TURN 6 дошёл до стадии technical verify`, "2026-04-20T16:40:12.424Z"),
        makeComment("так и где мы теперь?", "2026-04-21T16:54:37.668Z", true),
      ],
    });

    expect(context.latestExecutedTurn?.sequence).toBe(6);
    expect(context.turns).toHaveLength(6);
    expect(context.turns[2]?.request).toBe("Статус: продуктовый turn остановлен как platform incident.");
    expect(context.turns[3]?.request).toBe("Статус: запускаю новую execution wave после structural fixes.");
    expect(context.turns[4]?.request).toBe("Проверь сам через Бэк и пришли ссылку на видео и фото сюда в чат для проверки");
    expect(context.turns[5]?.request).toBe("Проверь сам через Бэк и пришли ссылку на видео и фото сюда в чат для проверки");
    expect(context.pendingUserRequests).toEqual([
      "Статус: возвращаю задачу в активный execution turn по прямому follow-up пользователя.",
      "Статус: запускаю новую execution wave после structural fixes.",
      "так и где мы теперь?",
    ]);
    expect(context.projectionWarning).toContain("новые user comments");
  });
});

describe("buildIssueNarrativeChatMessages", () => {
  it("builds a chat-first history with a user request, plain-language proof, and MR creation", () => {
    const comments = [
      makeComment("Добавь активацию по двойному тапу", "2026-04-16T13:47:28.574Z", true),
      makeComment(`<!-- paperclip-display-author: Atlas Bridge · Delivery Orchestrator -->
### Delivery Orchestrator

**Запрос принят**

Задачу разобрал и передаю ее в Atlas на execution.`, "2026-04-17T12:29:47.523Z"),
      makeComment(`<!-- paperclip-display-author: Atlas Bridge · Technical Verifier -->
### Technical Verifier

**Проверка пройдена**

- Что проверено: Подтверждено: сценарий «Project media surface regression» прошёл.
- Evidence: https://atlas.homio.pro/app/output/example.png`, "2026-04-17T12:39:30.635Z"),
      makeComment(`<!-- paperclip-display-author: Atlas Bridge · Reporter -->
### Reporter

**Задача готова к ревью**

**Коротко:** Все ожидаемые изменения доступны на стенде и готовы к human review.`, "2026-04-17T12:39:35.455Z"),
      makeComment("норм делай mr", "2026-04-17T15:08:22.950Z", true),
      makeComment(`## Reporter

MR: https://gitlab.kdigital.pro/homio/core/-/merge_requests/273
Ветка: \`task/paperclip-fc65ed66-c1d1-4732-9dd5-8ee7b5c4d313-fc65ed66\`

Создан новый GitLab MR для текущей ветки задачи.`, "2026-04-17T15:08:40.000Z"),
    ];

    const context = buildIssueExecutionCommentContext({
      issue: makeIssue(),
      projectedTurnNumber: 2,
      comments,
    });

    const messages = buildIssueNarrativeChatMessages({
      issue: makeIssue(),
      comments,
      context,
    });

    expect(messages.some((message) => message.speaker === "user" && message.body.includes("Сделай fullscreen gallery"))).toBe(true);
    const turnSummary = messages.find(
      (message) => message.speaker === "assistant" && message.body.includes("Что сделали:"),
    );
    expect(turnSummary?.body).toContain("Что сделали:");
    expect(turnSummary?.body).toContain("Что доказано:");
    expect(turnSummary?.body).toContain("не доказывает fullscreen gallery");
    expect(turnSummary?.links?.map((link) => link.label)).toEqual(
      expect.arrayContaining(["Полное описание", "Diff / файлы", "Артефакты / debug", "Комментарий"]),
    );
    expect(turnSummary?.links?.find((link) => link.label === "Полное описание")?.url).toBe("#document-atlas-execution");
    expect(turnSummary?.links?.find((link) => link.label === "Diff / файлы")?.url).toBe("#document-atlas-change-summary");
    expect(turnSummary?.links?.find((link) => link.label === "Артефакты / debug")?.url).toBe("#document-atlas-debug-pack");
    expect(turnSummary?.links?.find((link) => link.label === "Комментарий")?.url).toContain("#comment-");
    expect(messages.some((message) => message.speaker === "user" && message.body === "норм делай mr")).toBe(true);
    expect(messages.some((message) => message.speaker === "assistant" && message.body.includes("Создал MR"))).toBe(true);
    expect(messages.find((message) => message.body.includes("Создал MR"))?.links?.[0]?.url).toContain("/merge_requests/273");
  });
});
