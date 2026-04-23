import { ExternalLink } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";
import type { LiveRunForIssue } from "../../api/heartbeats";
import type { IssueExecutionCommentContext, IssueNarrativeChatMessage } from "../../lib/issue-execution-turns";
import type { PendingAtlasFollowupStatus } from "../../lib/issue-execution-flow";
import type { IssueConversationVerbosity } from "../../lib/issue-conversation-model";

function messageToneClasses(tone: IssueNarrativeChatMessage["tone"]) {
  switch (tone) {
    case "working":
      return "border-cyan-500/25 bg-cyan-500/[0.05]";
    case "success":
      return "border-emerald-500/25 bg-emerald-500/[0.05]";
    case "warn":
      return "border-amber-500/25 bg-amber-500/[0.05]";
    case "error":
      return "border-red-500/25 bg-red-500/[0.05]";
    default:
      return "border-border/70 bg-background/70";
  }
}

function ChatMessageCard({ message }: { message: IssueNarrativeChatMessage }) {
  const isUser = message.speaker === "user";
  const testId = isUser
    ? "issue-user-message"
    : message.kind === "system_ack"
      ? "issue-system-ack"
      : "issue-semantic-reply";
  return (
    <article
      data-testid={testId}
      className={cn("flex", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[88%] rounded-2xl border px-4 py-3 shadow-[var(--codex-surface-shadow)]",
          isUser
            ? "border-cyan-500/30 bg-cyan-500/[0.10]"
            : messageToneClasses(message.tone),
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {isUser ? "You" : "Atlas"}
          </span>
          <span className="text-[11px] text-muted-foreground" title={new Date(message.createdAt).toLocaleString()}>
            {relativeTime(message.createdAt)}
          </span>
        </div>
        <div className="mt-2 text-[15px] leading-7 text-foreground">{message.body}</div>
        {message.links?.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.links.map((link) => (
              <a
                key={`${message.id}-${link.url}`}
                href={link.url}
                target={link.url.startsWith("#") ? undefined : "_blank"}
                rel={link.url.startsWith("#") ? undefined : "noreferrer"}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs font-medium text-cyan-700 transition-colors hover:border-cyan-500/30 hover:text-cyan-600 dark:text-cyan-300"
              >
                {link.label}
                {!link.url.startsWith("#") ? <ExternalLink className="h-3 w-3" /> : null}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function statusToneClasses(state: PendingAtlasFollowupStatus["state"]) {
  switch (state) {
    case "blocked":
    case "failed":
      return "border-red-500/25 bg-red-500/[0.05]";
    case "completed":
      return "border-emerald-500/25 bg-emerald-500/[0.05]";
    case "accepted":
    case "queued":
    case "running":
      return "border-cyan-500/25 bg-cyan-500/[0.05]";
    default:
      return "border-amber-500/25 bg-amber-500/[0.05]";
  }
}

function followupBody(status: PendingAtlasFollowupStatus) {
  if (status.state === "blocked") {
    return status.summary || "Комментарий сохранён, но follow-up заблокирован.";
  }
  if (status.state === "failed") {
    return status.summary || "Запуск не удался.";
  }
  if (status.state === "completed") {
    return status.summary || "Запуск завершён.";
  }
  if (status.state === "running") {
    return [status.summary, status.turnLabel].filter(Boolean).join(" · ") || "Запуск идёт.";
  }
  if (status.state === "queued") {
    return [status.summary, status.turnLabel].filter(Boolean).join(" · ") || "Запуск поставлен в очередь.";
  }
  if (status.state === "accepted") {
    return [status.summary, status.turnLabel].filter(Boolean).join(" · ") || "Atlas принял follow-up.";
  }
  return [status.summary, status.turnLabel].filter(Boolean).join(" · ") || "Жду следующий update.";
}

function statusShowsActivity(state: PendingAtlasFollowupStatus["state"]) {
  return state === "pending" || state === "accepted" || state === "queued" || state === "running";
}

function ThinkingDots() {
  return (
    <span
      aria-hidden="true"
      data-testid="issue-pending-dots"
      className="inline-flex items-center gap-1"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-1.5 w-1.5 rounded-full bg-current opacity-35 animate-[issue-thinking-pulse_1.1s_ease-in-out_infinite]"
          style={{ animationDelay: `${index * 0.18}s` }}
        />
      ))}
    </span>
  );
}

function LiveStatusCard({ status }: { status: PendingAtlasFollowupStatus }) {
  const activity = statusShowsActivity(status.state);
  return (
    <article
      data-testid="issue-pending-message"
      data-state={status.state}
      className={cn("rounded-2xl border px-4 py-3 shadow-[var(--codex-surface-shadow)]", statusToneClasses(status.state))}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Atlas</span>
        <span className="text-[11px] font-semibold text-foreground">{status.title}</span>
        {activity ? <ThinkingDots /> : null}
        {status.turnLabel ? (
          <span className="text-[11px] text-muted-foreground">{status.turnLabel}</span>
        ) : null}
      </div>
      <div className="mt-2 text-[15px] leading-7 text-foreground">{followupBody(status)}</div>
      {status.detail && status.detail !== status.summary ? (
        <div className="mt-2 text-sm leading-6 text-muted-foreground">{status.detail}</div>
      ) : null}
    </article>
  );
}

export function IssueConversationSurface({
  companyId: _companyId,
  liveRuns: _liveRuns,
  context: _context,
  verbosity: _verbosity,
  onVerbosityChange: _onVerbosityChange,
  pendingFollowupStatus,
  chatMessages,
}: {
  companyId?: string | null;
  liveRuns?: LiveRunForIssue[];
  context?: IssueExecutionCommentContext | null;
  verbosity?: IssueConversationVerbosity;
  onVerbosityChange?: (value: IssueConversationVerbosity) => void;
  pendingFollowupStatus?: PendingAtlasFollowupStatus | null;
  chatMessages?: IssueNarrativeChatMessage[] | null;
}) {
  const visibleMessages = chatMessages ?? [];
  return (
    <section className="codex-issue-surface space-y-4" data-testid="issue-conversation-surface">
      <style>{`
        @keyframes issue-thinking-pulse {
          0%, 100% { opacity: 0.28; transform: translateY(0); }
          50% { opacity: 1; transform: translateY(-1px); }
        }
      `}</style>
      <div className="space-y-3" data-testid="issue-chat-thread">
        {visibleMessages.map((message) => (
          <ChatMessageCard key={message.id} message={message} />
        ))}
        {pendingFollowupStatus ? (
          <LiveStatusCard status={pendingFollowupStatus} />
        ) : null}
      </div>
    </section>
  );
}
