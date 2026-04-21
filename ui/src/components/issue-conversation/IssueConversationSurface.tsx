import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, ShieldAlert, Sparkles, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "@/lib/utils";
import type { LiveRunForIssue } from "../../api/heartbeats";
import type { IssueExecutionCommentContext } from "../../lib/issue-execution-turns";
import type { PendingAtlasFollowupStatus } from "../../lib/issue-execution-flow";
import type { IssueChatLiveFeedItem } from "../../lib/issue-chat-live-transport";
import { useLiveRunTranscripts } from "../transcript/useLiveRunTranscripts";
import {
  buildIssueConversationModel,
  type IssueConversationArtifact,
  type IssueConversationPhaseBundle,
  type IssueConversationTurnCard,
  type IssueConversationVerbosity,
} from "../../lib/issue-conversation-model";

function isAnimatedLiveState(state: PendingAtlasFollowupStatus["state"] | null | undefined) {
  return state === "pending" || state === "accepted" || state === "queued" || state === "running";
}

function LiveThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 rounded-full bg-current animate-pulse"
          style={{ animationDelay: `${index * 180}ms`, animationDuration: "1s" }}
        />
      ))}
    </span>
  );
}

function toneClasses(tone: IssueConversationTurnCard["tone"]) {
  switch (tone) {
    case "working":
      return "border-cyan-500/18 bg-background/92";
    case "success":
      return "border-emerald-500/18 bg-background/92";
    case "warning":
      return "border-amber-500/18 bg-background/92";
    case "danger":
      return "border-red-500/18 bg-background/92";
    default:
      return "border-border/70 bg-background/92";
  }
}

function statusBadgeClasses(status: IssueConversationTurnCard["status"]) {
  switch (status) {
    case "running":
      return "border-cyan-500/25 bg-cyan-500/[0.08] text-cyan-800 dark:text-cyan-200";
    case "completed":
      return "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-200";
    case "failed":
      return "border-red-500/25 bg-red-500/[0.08] text-red-800 dark:text-red-200";
    case "queued":
      return "border-border/70 bg-background/70 text-muted-foreground";
    case "blocked":
      return "border-amber-500/25 bg-amber-500/[0.08] text-amber-800 dark:text-amber-200";
    default:
      return "border-border/70 bg-background/70 text-muted-foreground";
  }
}

function ArtifactChip({ artifact }: { artifact: IssueConversationArtifact }) {
  return (
    <a
      href={artifact.url}
      target={artifact.url.startsWith("#") ? undefined : "_blank"}
      rel={artifact.url.startsWith("#") ? undefined : "noreferrer"}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors hover:bg-accent/30",
        artifact.kind === "evidence" && "border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-800 dark:text-emerald-200",
        artifact.kind === "preview" && "border-cyan-500/20 bg-cyan-500/[0.05] text-cyan-800 dark:text-cyan-200",
        artifact.kind === "diff" && "border-violet-500/20 bg-violet-500/[0.05] text-violet-800 dark:text-violet-200",
        artifact.kind === "debug" && "border-border/70 bg-background/60 text-muted-foreground",
      )}
    >
      <span>{artifact.label}</span>
      <span className="text-[10px] uppercase tracking-[0.16em] opacity-70">
        {artifact.durability === "durable" ? "durable" : "live"}
      </span>
      {!artifact.url.startsWith("#") ? <ExternalLink className="h-3 w-3" /> : null}
    </a>
  );
}

function PhaseBundleRow({ bundle, defaultOpen = false }: { bundle: IssueConversationPhaseBundle; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border/60 bg-background/70 px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[12px] font-medium">{bundle.label}</span>
          {bundle.itemCount ? (
            <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {bundle.itemCount}
            </span>
          ) : null}
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open ? (
        <div className="pt-2 pl-6 text-xs leading-5 text-muted-foreground">
          {bundle.summary}
        </div>
      ) : null}
    </div>
  );
}

function TurnCard({
  turn,
  verbosity,
}: {
  turn: IssueConversationTurnCard;
  verbosity: "brief" | "standard" | "debug";
}) {
  const showAllBundles = verbosity === "debug";
  const visibleBundles = showAllBundles ? turn.phaseBundles : turn.phaseBundles.slice(0, 3);

  return (
    <article className={cn("rounded-2xl border p-3.5 shadow-[var(--codex-surface-shadow)] animate-in fade-in slide-in-from-bottom-3 duration-500", toneClasses(turn.tone))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("rounded-full", statusBadgeClasses(turn.status))}>
              {turn.statusLabel}
            </Badge>
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Turn {turn.sequence}
            </span>
            {turn.updatedAt ? (
              <span className="text-xs text-muted-foreground">
                {relativeTime(turn.updatedAt)}
              </span>
            ) : null}
          </div>
          <div className="max-w-3xl rounded-xl border border-border/60 bg-background/80 px-3.5 py-2.5 text-[13px] leading-6 text-foreground">
            {turn.request}
          </div>
        </div>
        <div className="shrink-0">
          {turn.proofState === "review_ready" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/[0.08] px-2.5 py-1 text-xs text-emerald-800 dark:text-emerald-200">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Proof ready
            </span>
          ) : turn.proofState === "weak" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-2.5 py-1 text-xs text-amber-800 dark:text-amber-200">
              <ShieldAlert className="h-3.5 w-3.5" />
              Weak proof
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="text-sm leading-6 text-foreground">
          {turn.summary}
        </div>
      {turn.proofSummary ? (
        <div className="rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-[13px] text-muted-foreground">
          {turn.proofSummary}
        </div>
        ) : null}
        {turn.nextAction ? (
          <div className="rounded-xl border border-dashed border-border/70 px-3 py-2 text-[12px] leading-5 text-muted-foreground">
            {turn.nextAction}
          </div>
        ) : null}
      </div>

      {visibleBundles.length > 0 ? (
        <div className="mt-4 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Collapsed work
          </div>
          {visibleBundles.map((bundle, index) => (
            <PhaseBundleRow
              key={bundle.id}
              bundle={bundle}
              defaultOpen={verbosity === "debug" || (turn.status === "failed" && index === visibleBundles.length - 1)}
            />
          ))}
          {!showAllBundles && turn.phaseBundles.length > visibleBundles.length ? (
            <div className="pl-1 text-xs text-muted-foreground">
              +{turn.phaseBundles.length - visibleBundles.length} more internal bundles in debug mode
            </div>
          ) : null}
        </div>
      ) : null}

      {turn.artifacts.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {turn.artifacts
            .filter((artifact) => verbosity === "debug" || artifact.kind !== "debug")
            .map((artifact) => <ArtifactChip key={`${turn.id}-${artifact.label}`} artifact={artifact} />)}
        </div>
      ) : null}
    </article>
  );
}

export function IssueConversationSurface({
  companyId,
  liveRuns,
  context,
  verbosity,
  onVerbosityChange,
  pendingFollowupStatus,
  liveFeed,
}: {
  companyId?: string | null;
  liveRuns: LiveRunForIssue[];
  context: IssueExecutionCommentContext | null;
  verbosity: IssueConversationVerbosity;
  onVerbosityChange: (value: IssueConversationVerbosity) => void;
  pendingFollowupStatus?: PendingAtlasFollowupStatus | null;
  liveFeed?: IssueChatLiveFeedItem[] | null;
}) {
  const { transcriptByRun } = useLiveRunTranscripts({
    runs: liveRuns,
    companyId,
  });

  const model = useMemo(
    () => buildIssueConversationModel({
      context,
      liveRuns,
      transcriptByRun,
      verbosity,
    }),
    [context, liveRuns, transcriptByRun, verbosity],
  );

  return (
    <section className="codex-issue-surface space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
            Chat
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            Human-readable turns first. Heavy execution detail stays in Task Dashboard and History.
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border/70 bg-background/80 p-1">
          {(["auto", "brief", "debug"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              variant={verbosity === option ? "secondary" : "ghost"}
              size="xs"
              className="rounded-full capitalize"
              onClick={() => onVerbosityChange(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {pendingFollowupStatus ? (
          <div
            className={cn(
              "rounded-2xl border px-3.5 py-3 animate-in fade-in slide-in-from-bottom-2 duration-500",
              pendingFollowupStatus.state === "blocked"
                ? "border-red-500/25 bg-red-500/[0.05]"
                : pendingFollowupStatus.state === "failed"
                  ? "border-red-500/25 bg-red-500/[0.05]"
                  : pendingFollowupStatus.state === "accepted" || pendingFollowupStatus.state === "queued"
                    ? "border-cyan-500/25 bg-cyan-500/[0.05]"
                    : pendingFollowupStatus.state === "completed"
                      ? "border-emerald-500/25 bg-emerald-500/[0.05]"
                      : pendingFollowupStatus.state === "running"
                      ? "border-cyan-500/25 bg-cyan-500/[0.05]"
                      : "border-amber-500/25 bg-amber-500/[0.05]",
            )}
          >
            <div className="flex items-start gap-3">
              {pendingFollowupStatus.state === "completed" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
              ) : pendingFollowupStatus.state === "blocked" || pendingFollowupStatus.state === "failed" ? (
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
              ) : pendingFollowupStatus.state === "accepted" || pendingFollowupStatus.state === "queued" || pendingFollowupStatus.state === "running" || pendingFollowupStatus.state === "pending" ? (
                <span className="mt-0.5 inline-flex h-4 shrink-0 items-center text-cyan-600 dark:text-cyan-300">
                  <LiveThinkingDots />
                </span>
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">
                  {pendingFollowupStatus.title}
                </div>
                {pendingFollowupStatus.summary && pendingFollowupStatus.summary !== pendingFollowupStatus.title ? (
                  <div className="mt-1 text-[13px] leading-6 text-muted-foreground">{pendingFollowupStatus.summary}</div>
                ) : null}
                {pendingFollowupStatus.detail && !isAnimatedLiveState(pendingFollowupStatus.state) ? (
                  <div className="mt-1 text-[12px] leading-5 text-muted-foreground/80">{pendingFollowupStatus.detail}</div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {liveFeed && liveFeed.length > 0 ? (
          <div className="rounded-2xl border border-border/70 bg-background/92 px-3.5 py-3 shadow-[var(--codex-surface-shadow)] animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Live relay
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {liveFeed.slice(0, verbosity === "debug" ? undefined : 4).map((item) => (
                <div
                  key={item.key}
                  className={cn(
                    "rounded-xl border px-3 py-2",
                    item.tone === "danger" && "border-red-500/20 bg-red-500/[0.04]",
                    item.tone === "warning" && "border-amber-500/20 bg-amber-500/[0.04]",
                    item.tone === "success" && "border-emerald-500/20 bg-emerald-500/[0.04]",
                    item.tone === "working" && "border-cyan-500/20 bg-cyan-500/[0.04]",
                    item.tone === "neutral" && "border-border/60 bg-background/70",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium">{item.title}</div>
                      <div className="mt-1 text-[12px] leading-5 text-muted-foreground">{item.summary}</div>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(item.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {model.liveStrip ? (
          <div
            className={cn(
              "rounded-2xl border p-3.5 shadow-[var(--codex-surface-shadow)] animate-in fade-in slide-in-from-bottom-2 duration-500",
              model.liveStrip.tone === "danger"
                ? "border-red-500/25 bg-red-500/[0.06]"
                : model.liveStrip.tone === "warning"
                  ? "border-amber-500/25 bg-amber-500/[0.06]"
                  : "border-cyan-500/25 bg-cyan-500/[0.05]",
            )}
          >
            <div className="flex items-start gap-3">
              {model.liveStrip.tone === "danger" ? (
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
              ) : model.liveStrip.tone === "warning" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
              ) : (
                <span className="mt-0.5 inline-flex h-4 shrink-0 items-center text-cyan-600 dark:text-cyan-300">
                  <LiveThinkingDots />
                </span>
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">{model.liveStrip.title}</div>
                {model.liveStrip.summary ? (
                  <div className="mt-1 text-[13px] leading-6 text-muted-foreground">{model.liveStrip.summary}</div>
                ) : null}
                {model.liveStrip.bundles.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {model.liveStrip.bundles.slice(0, model.effectiveVerbosity === "debug" ? undefined : 3).map((bundle) => (
                      <span key={bundle.id} className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
                        {bundle.label}
                        {bundle.itemCount ? ` · ${bundle.itemCount}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {model.attention ? (
          <div
            className={cn(
              "rounded-2xl border px-3.5 py-3 animate-in fade-in slide-in-from-bottom-2 duration-500",
              model.attention.tone === "danger"
                ? "border-red-500/25 bg-red-500/[0.05]"
                : model.attention.tone === "working"
                  ? "border-cyan-500/25 bg-cyan-500/[0.04]"
                  : "border-amber-500/25 bg-amber-500/[0.05]",
            )}
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="text-[12px] font-semibold">{model.attention.title}</div>
                <div className="mt-1 text-[12px] leading-6 text-muted-foreground">{model.attention.body}</div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="space-y-4">
          {model.turns.map((turn) => (
            <TurnCard key={turn.id} turn={turn} verbosity={model.effectiveVerbosity} />
          ))}
        </div>
      </div>
    </section>
  );
}
