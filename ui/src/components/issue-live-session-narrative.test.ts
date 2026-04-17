import { describe, expect, it } from "vitest";
import { buildAtlasExecutionNarrativeSummary, buildNarrativeSummary } from "./issue-live-session-narrative";

describe("buildAtlasExecutionNarrativeSummary", () => {
  it("turns Atlas execution milestones into a readable narrative fallback", () => {
    const summary = buildAtlasExecutionNarrativeSummary(
      {
        currentState: "Execution завершен и готов к review.",
        summary: "VerifyReport зеленый, evidence опубликован.",
        latestRequest: "Добавь активацию по двойному тапу",
        executorSummary: "Добавил fullscreen controls и zoom-поведение.",
        verifierScope: "Project media surface regression",
        verificationLimitations: ["Нужна ручная проверка в UI для жестов и double tap."],
        standUrl: "https://ai03.homio.pro",
        recentMilestones: [
          {
            role: "Atlas Executor",
            title: "TURN 1 взят в работу",
            summary: "Исполнение идет в ai03.",
            at: "2026-04-17T10:08:34.000Z",
          },
          {
            role: "Technical Verifier",
            title: "Проверка пройдена",
            summary: "Подтверждено: сценарий прошёл.",
            at: "2026-04-17T10:16:23.000Z",
          },
        ],
      },
      true,
    );

    expect(summary.current?.title).toBe("Проверка пройдена");
    expect(summary.current?.detail).toContain("Technical Verifier");
    expect(summary.timeline).toHaveLength(2);
    expect(summary.statusLine).toContain("Execution завершен");
    expect(summary.statusLine).toContain("Последний исполненный запрос");
    expect(summary.statusLine).toContain("Исполнитель заявил");
    expect(summary.statusLine).toContain("Verifier подтвердил");
    expect(summary.statusLine).toContain("double tap");
    expect(summary.statusLine).toContain("Stand: https://ai03.homio.pro");
  });

  it("keeps timeline timestamps stable when milestones do not provide explicit dates", () => {
    const summary = buildAtlasExecutionNarrativeSummary(
      {
        updatedAt: "2026-04-17T10:18:00.000Z",
        recentMilestones: [
          {
            role: "Atlas Executor",
            title: "TURN 1 взят в работу",
            summary: "Исполнение идет в ai03.",
            at: null,
          },
          {
            role: "Reporter",
            title: "Готово к проверке человеком",
            summary: "Результат готов к review.",
            at: null,
          },
        ],
      },
      false,
    );

    expect(summary.timeline[0]?.ts).toBe("2026-04-17T10:18:00.000Z");
    expect(summary.timeline[1]?.ts).toBe("2026-04-17T10:18:00.000Z");
  });
});

describe("buildNarrativeSummary", () => {
  it("preserves the readable transcript path for regular runs", () => {
    const summary = buildNarrativeSummary(
      [
        {
          kind: "assistant",
          ts: "2026-04-17T10:08:34.000Z",
          text: "Inspecting the failing route and collecting logs.",
        },
        {
          kind: "result",
          ts: "2026-04-17T10:16:23.000Z",
          text: "Applied a fix and published a fresh screenshot.",
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          subtype: "success",
          isError: false,
          errors: [],
        },
      ],
      false,
    );

    expect(summary.current?.title).toBe("Result is ready");
    expect(summary.timeline.length).toBeGreaterThanOrEqual(1);
    expect(summary.statusLine).toContain("ready for review");
  });
});
