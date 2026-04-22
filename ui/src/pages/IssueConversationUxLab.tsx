import { useState } from "react";
import type { IssueExecutionCommentContext } from "../lib/issue-execution-turns";
import { IssueConversationSurface } from "../components/issue-conversation/IssueConversationSurface";
import { IssueConversationComposer } from "../components/issue-conversation/IssueConversationComposer";
import type { IssueConversationVerbosity } from "../lib/issue-conversation-model";
import type { LiveRunForIssue } from "../api/heartbeats";

function makeContext(input: {
  projectionWarning?: string | null;
  pendingUserRequests?: string[];
  pendingConversation?: IssueExecutionCommentContext["pendingConversation"];
  turns: IssueExecutionCommentContext["turns"];
}): IssueExecutionCommentContext {
  return {
    turns: input.turns,
    latestExecutedTurn: input.turns[input.turns.length - 1] ?? null,
    pendingUserRequests: input.pendingUserRequests ?? [],
    pendingConversation: input.pendingConversation ?? [],
    projectionWarning: input.projectionWarning ?? null,
  };
}

const runningContext = makeContext({
  turns: [
    {
      sequence: 1,
      request: "Сделай главный task flow спокойным и выведи raw logs из основного потока.",
      startedAt: "2026-04-19T08:12:00.000Z",
      settledAt: "2026-04-19T08:18:00.000Z",
      status: "settled",
      verifierScope: null,
      standUrl: "https://ai01.homio.pro",
      evidenceUrl: null,
      outcome: "Execution запущен",
      latestCommentId: "fixture-1",
      events: [
        { role: "Delivery Orchestrator", title: "Запрос принят", summary: "Разложил задачу и запустил execution.", createdAt: "2026-04-19T08:12:00.000Z", sourceCommentId: "fixture-1" },
        { role: "Atlas Executor", title: "Execution запущен", summary: "Atlas поднимает workspace и готовит правку.", createdAt: "2026-04-19T08:13:00.000Z", sourceCommentId: "fixture-2" },
      ],
    },
  ],
  pendingUserRequests: ["И добавь slash-команды /mr и /cancel прямо в composer."],
  pendingConversation: [
    {
      id: "running-user-1",
      speaker: "user",
      body: "И добавь slash-команды /mr и /cancel прямо в composer.",
      createdAt: "2026-04-19T08:20:00.000Z",
      tone: "info",
    },
    {
      id: "running-assistant-1",
      speaker: "assistant",
      body: "Принял follow-up. Это Atlas Executor.",
      createdAt: "2026-04-19T08:20:03.000Z",
      tone: "working",
    },
  ],
  projectionWarning: "После последнего Atlas turn появились новые user comments (1), но новый execution ещё не начался.",
});

const reviewReadyContext = makeContext({
  turns: [
    {
      sequence: 1,
      request: "Сделай Conversation default surface и убери debug noise в dashboard.",
      startedAt: "2026-04-19T07:00:00.000Z",
      settledAt: "2026-04-19T07:24:00.000Z",
      status: "settled",
      verifierScope: "Подтверждено: issue page показывает новый conversation flow, preview и evidence доступны.",
      standUrl: "https://ai02.homio.pro",
      evidenceUrl: "https://atlas.homio.pro/app/output/review-ready.png",
      outcome: "Задача готова к ревью",
      latestCommentId: "fixture-3",
      events: [
        { role: "Delivery Orchestrator", title: "Запрос принят", summary: "Поставил новый surface как default.", createdAt: "2026-04-19T07:00:00.000Z", sourceCommentId: "fixture-3" },
        { role: "Stand Controller", title: "Preview обновлен", summary: "Новый layout выложен на стенд.", createdAt: "2026-04-19T07:14:00.000Z", sourceCommentId: "fixture-4" },
        { role: "Technical Verifier", title: "Проверка пройдена", summary: "Подтвержден основной сценарий task conversation.", createdAt: "2026-04-19T07:21:00.000Z", sourceCommentId: "fixture-5" },
        { role: "Reporter", title: "Задача готова к ревью", summary: "Основной поток спокоен, debug вынесен в dashboard.", createdAt: "2026-04-19T07:24:00.000Z", sourceCommentId: "fixture-6" },
      ],
    },
  ],
});

const weakProofContext = makeContext({
  turns: [
    {
      sequence: 1,
      request: "Сделай task conversation как в Codex desktop.",
      startedAt: "2026-04-19T06:00:00.000Z",
      settledAt: "2026-04-19T06:26:00.000Z",
      status: "settled",
      verifierScope: "Автопроверка была слишком общей и не доказала, что нужная правка действительно работает.",
      standUrl: "https://ai03.homio.pro",
      evidenceUrl: "https://atlas.homio.pro/app/output/weak-proof.png",
      outcome: "Задача готова к ревью",
      latestCommentId: "fixture-7",
      events: [
        { role: "Atlas Executor", title: "Execution запущен", summary: "Собрал новый layout.", createdAt: "2026-04-19T06:02:00.000Z", sourceCommentId: "fixture-7" },
        { role: "Technical Verifier", title: "Проверка пройдена", summary: "Проверка слишком общая, нет точного доказательства.", createdAt: "2026-04-19T06:20:00.000Z", sourceCommentId: "fixture-8" },
        { role: "Reporter", title: "Задача готова к ревью", summary: "Выглядит готово, но нужен человеческий взгляд.", createdAt: "2026-04-19T06:26:00.000Z", sourceCommentId: "fixture-9" },
      ],
    },
  ],
});

const failedContext = makeContext({
  turns: [
    {
      sequence: 1,
      request: "Добавь анимации и slash commands без перегруза основного потока.",
      startedAt: "2026-04-19T05:00:00.000Z",
      settledAt: "2026-04-19T05:19:00.000Z",
      status: "settled",
      verifierScope: "Подтверждено: сценарий проверки сломан, dropdown slash-команд не открылся.",
      standUrl: "https://ai04.homio.pro",
      evidenceUrl: null,
      outcome: "Проверка не прошла",
      latestCommentId: "fixture-10",
      events: [
        { role: "Atlas Executor", title: "Execution запущен", summary: "Собрал slash palette.", createdAt: "2026-04-19T05:02:00.000Z", sourceCommentId: "fixture-10" },
        { role: "Technical Verifier", title: "Проверка не прошла", summary: "Slash palette не открывается по /. ", createdAt: "2026-04-19T05:19:00.000Z", sourceCommentId: "fixture-11" },
      ],
    },
  ],
});

const syntheticLiveRun: LiveRunForIssue = {
  id: "synthetic-running",
  status: "running",
  invocationSource: "atlas_execution",
  triggerDetail: "Fixture live execution",
  startedAt: "2026-04-19T08:13:00.000Z",
  finishedAt: null,
  createdAt: "2026-04-19T08:13:00.000Z",
  agentId: "atlas-executor",
  agentName: "Atlas Executor",
  adapterType: "atlas_execution",
  issueId: "fixture-running",
  syntheticSource: "atlas_execution",
  openable: false,
  slotEnv: "ai01",
};

export function IssueConversationUxLab() {
  const [verbosity, setVerbosity] = useState<IssueConversationVerbosity>("auto");

  return (
    <div className="codex-issue-surface space-y-7">
      <div className="rounded-2xl border border-border/70 bg-background/90 p-5 shadow-[var(--codex-surface-shadow)]">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
          UX Lab
        </div>
        <h1 className="mt-2 text-[28px] font-semibold tracking-tight">Issue Conversation Surface</h1>
        <p className="mt-2 max-w-3xl text-[13px] leading-6 text-muted-foreground">
          Stable fixture page for the Codex-like issue surface. Use it to review animation, conversation density,
          current panels, and slash-command behavior before hitting live issue data.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Composer With Slash Commands</h2>
        <IssueConversationComposer
          onAdd={async () => {}}
          onAttachImage={async () => {}}
          currentAssigneeValue=""
          suggestedAssigneeValue=""
          mentions={[
            {
              id: "agent:atlas-executor",
              name: "Atlas Executor",
              kind: "agent",
              agentId: "atlas-executor",
            },
            {
              id: "project:ux",
              name: "UX Refresh",
              kind: "project",
              projectId: "project-ux",
              projectColor: "#0891b2",
            },
          ]}
          composerStatusSlot={
            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.06] px-3 py-2 text-xs text-cyan-900 dark:text-cyan-100">
              Type <code>/mr</code>, <code>/cancel</code>, <code>/reopen</code>, <code>/mention</code>, or <code>/attach</code> to preview the slash-command palette.
            </div>
          }
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Running / Projection Stale</h2>
        <IssueConversationSurface
          companyId={null}
          liveRuns={[syntheticLiveRun]}
          context={runningContext}
          verbosity={verbosity}
          onVerbosityChange={setVerbosity}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Review Ready</h2>
        <IssueConversationSurface
          companyId={null}
          liveRuns={[]}
          context={reviewReadyContext}
          verbosity={verbosity}
          onVerbosityChange={setVerbosity}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Weak Proof</h2>
        <IssueConversationSurface
          companyId={null}
          liveRuns={[]}
          context={weakProofContext}
          verbosity={verbosity}
          onVerbosityChange={setVerbosity}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Failed / Follow-up Needed</h2>
        <IssueConversationSurface
          companyId={null}
          liveRuns={[]}
          context={failedContext}
          verbosity={verbosity}
          onVerbosityChange={setVerbosity}
        />
      </section>
    </div>
  );
}
