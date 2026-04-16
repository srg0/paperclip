import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import { buildNarrativeSummary, type NarrativeStep, type NarrativeTone } from "./issue-live-session-narrative";
import { Identity } from "./Identity";
import { StatusBadge } from "./StatusBadge";
import { RunTranscriptView, type TranscriptMode } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import {
  Check,
  CircleAlert,
  ExternalLink,
  Loader2,
  RadioTower,
  Sparkles,
  Square,
  TerminalSquare,
} from "lucide-react";

interface IssueLiveSessionPanelProps {
  issueId: string;
  companyId?: string | null;
}

type SessionViewMode = "narrative" | "stream";

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function isRunActive(status: string): boolean {
  return status === "queued" || status === "running";
}

function isSyntheticAtlasRun(run: LiveRunForIssue): boolean {
  return run.syntheticSource === "atlas_execution";
}

function toneStyles(tone: NarrativeTone) {
  switch (tone) {
    case "success":
      return {
        dot: "bg-emerald-500",
        badge: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-200",
        card: "border-emerald-500/25 bg-emerald-500/[0.05]",
      };
    case "warn":
      return {
        dot: "bg-amber-500",
        badge: "border-amber-500/30 bg-amber-500/[0.08] text-amber-800 dark:text-amber-200",
        card: "border-amber-500/25 bg-amber-500/[0.05]",
      };
    case "error":
      return {
        dot: "bg-red-500",
        badge: "border-red-500/30 bg-red-500/[0.08] text-red-800 dark:text-red-200",
        card: "border-red-500/25 bg-red-500/[0.05]",
      };
    case "working":
      return {
        dot: "bg-cyan-500",
        badge: "border-cyan-500/30 bg-cyan-500/[0.08] text-cyan-800 dark:text-cyan-200",
        card: "border-cyan-500/25 bg-cyan-500/[0.05]",
      };
    default:
      return {
        dot: "bg-slate-400",
        badge: "border-border/70 bg-background/80 text-muted-foreground",
        card: "border-border/70 bg-background/60",
      };
  }
}

function ToneIcon({ tone, className }: { tone: NarrativeTone; className?: string }) {
  if (tone === "success") return <Check className={className} />;
  if (tone === "error" || tone === "warn") return <CircleAlert className={className} />;
  if (tone === "working") return <Loader2 className={cn("animate-spin", className)} />;
  return <TerminalSquare className={className} />;
}

function NarrativeTimeline({ timeline }: { timeline: NarrativeStep[] }) {
  return (
    <div className="space-y-2">
      {timeline.map((step, index) => {
        const tone = toneStyles(step.tone);
        const isLatest = index === timeline.length - 1;
        return (
          <div
            key={`${step.ts}-${step.title}-${index}`}
            className={cn(
              "rounded-xl border px-3 py-3 transition-colors",
              isLatest ? tone.card : "border-border/70 bg-background/55",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex h-2.5 w-2.5 rounded-full", tone.dot)} />
                  <div className="text-sm font-medium">{step.title}</div>
                </div>
                {step.detail ? (
                  <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {step.detail}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {relativeTime(step.ts)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NarrativeRunSection({
  run,
  summary,
}: {
  run: LiveRunForIssue;
  summary: ReturnType<typeof buildNarrativeSummary>;
}) {
  const currentTone = toneStyles(summary.current?.tone ?? "info");

  return (
    <div className="space-y-3">
      <div className={cn("rounded-2xl border px-4 py-4 shadow-[0_12px_32px_rgba(15,23,42,0.08)]", currentTone.card)}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn("rounded-full border text-[10px] uppercase tracking-[0.18em]", currentTone.badge)}>
            Current focus
          </Badge>
          {summary.current ? (
            <span className="text-[11px] text-muted-foreground">{relativeTime(summary.current.ts)}</span>
          ) : null}
        </div>
        <div className="mt-3 flex items-start gap-3">
          <span className={cn("mt-0.5 rounded-full border p-1.5", currentTone.badge)}>
            <ToneIcon tone={summary.current?.tone ?? "info"} className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              {summary.current?.title ?? (isRunActive(run.status) ? "Live session started" : "No readable checkpoints yet")}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {summary.current?.detail || summary.statusLine}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-border/70 bg-background/45 px-4 py-3 text-xs text-muted-foreground">
        {summary.statusLine}
      </div>

      {summary.timeline.length > 0 ? (
        <NarrativeTimeline timeline={summary.timeline} />
      ) : null}
    </div>
  );
}

function RunHeader({
  run,
  isActive,
  isSynthetic,
  cancelling,
  onCancel,
}: {
  run: LiveRunForIssue;
  isActive: boolean;
  isSynthetic: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <Link to={`/agents/${run.agentId}`} className="inline-flex hover:underline">
          <Identity name={run.agentName} size="sm" />
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 font-mono">
            {run.id.slice(0, 8)}
          </span>
          <StatusBadge status={run.status} />
          <span>{formatDateTime(run.startedAt ?? run.createdAt)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isActive && !isSynthetic ? (
          <button
            onClick={onCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/[0.12] dark:text-red-300 disabled:opacity-50"
          >
            <Square className="h-2.5 w-2.5" fill="currentColor" />
            {cancelling ? "Stopping…" : "Stop"}
          </button>
        ) : null}

        {isSynthetic ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
            Atlas execution
          </span>
        ) : (
          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] font-medium text-cyan-700 transition-colors hover:border-cyan-500/30 hover:text-cyan-600 dark:text-cyan-300"
          >
            Open run
            <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

export function IssueLiveSessionPanel({ issueId, companyId }: IssueLiveSessionPanelProps) {
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<SessionViewMode>("narrative");
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("nice");
  const [cancellingRunIds, setCancellingRunIds] = useState(new Set<string>());

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const runs = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns ?? []) {
      deduped.set(run.id, run);
    }
    if (activeRun) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
        issueId,
      });
    }
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activeRun, issueId, liveRuns]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({ runs, companyId });

  const activeCount = useMemo(
    () => runs.filter((run) => isRunActive(run.status)).length,
    [runs],
  );

  const handleCancelRun = async (runId: string) => {
    setCancellingRunIds((prev) => new Set(prev).add(runId));
    try {
      await heartbeatsApi.cancel(runId);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
    } finally {
      setCancellingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  if (runs.length === 0) return null;

  return (
    <Tabs
      value={viewMode}
      onValueChange={(value) => setViewMode(value as SessionViewMode)}
      className="overflow-hidden rounded-2xl border border-cyan-500/25 bg-[linear-gradient(135deg,rgba(6,182,212,0.08),transparent_28%),linear-gradient(180deg,rgba(245,158,11,0.08),transparent_40%),var(--background)] shadow-[0_22px_60px_rgba(6,182,212,0.08)]"
    >
      <div className="border-b border-border/60 bg-background/75 px-4 py-4 backdrop-blur">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/[0.08] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-700 dark:text-cyan-300">
              <Sparkles className="h-3.5 w-3.5" />
              Interactive Session
            </div>
            <div className="mt-3 text-sm font-semibold">Readable live execution for this task</div>
            <div className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              Follow the agent in plain English, then switch to the full stream when you need raw detail.
              Comments below stay live, so you can redirect the session without leaving the task.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="rounded-full border-border/70 bg-background/80">
              {activeCount > 0 ? `${activeCount} live` : "Settled"}
            </Badge>
            <Badge variant="outline" className="rounded-full border-border/70 bg-background/80">
              {runs.length} run{runs.length === 1 ? "" : "s"}
            </Badge>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TabsList variant="line" className="w-fit justify-start gap-1">
            <TabsTrigger value="narrative" className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              Narrative
            </TabsTrigger>
            <TabsTrigger value="stream" className="gap-1.5">
              <RadioTower className="h-3.5 w-3.5" />
              Full stream
            </TabsTrigger>
          </TabsList>

          {viewMode === "stream" ? (
            <div className="inline-flex rounded-lg border border-border/70 bg-background/70 p-0.5">
              {(["nice", "raw"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                    transcriptMode === mode
                      ? "bg-accent text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setTranscriptMode(mode)}
                >
                  {mode === "nice" ? "Readable" : "Raw"}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <TabsContent value="narrative" className="m-0">
        <div className="divide-y divide-border/60">
          {runs.map((run) => {
            const isActive = isRunActive(run.status);
            const isSynthetic = isSyntheticAtlasRun(run);
            const transcript = transcriptByRun.get(run.id) ?? [];
            const summary = buildNarrativeSummary(transcript, isActive);

            return (
              <section key={run.id} className="px-4 py-4">
                <RunHeader
                  run={run}
                  isActive={isActive}
                  isSynthetic={isSynthetic}
                  cancelling={cancellingRunIds.has(run.id)}
                  onCancel={() => handleCancelRun(run.id)}
                />
                <NarrativeRunSection run={run} summary={summary} />
              </section>
            );
          })}
        </div>
      </TabsContent>

      <TabsContent value="stream" className="m-0">
        <div className="divide-y divide-border/60">
          {runs.map((run) => {
            const isActive = isRunActive(run.status);
            const isSynthetic = isSyntheticAtlasRun(run);
            const transcript = transcriptByRun.get(run.id) ?? [];

            return (
              <section key={run.id} className="px-4 py-4">
                <RunHeader
                  run={run}
                  isActive={isActive}
                  isSynthetic={isSynthetic}
                  cancelling={cancellingRunIds.has(run.id)}
                  onCancel={() => handleCancelRun(run.id)}
                />

                <div className="max-h-[360px] overflow-y-auto pr-1">
                  <RunTranscriptView
                    entries={transcript}
                    mode={transcriptMode}
                    density="compact"
                    streaming={isActive}
                    collapseStdout
                    emptyMessage={
                      isSynthetic
                        ? "Waiting for Atlas execution updates in the issue summary..."
                        : hasOutputForRun(run.id)
                          ? "Waiting for transcript parsing..."
                          : "Waiting for run output..."
                    }
                  />
                </div>
              </section>
            );
          })}
        </div>
      </TabsContent>
    </Tabs>
  );
}
