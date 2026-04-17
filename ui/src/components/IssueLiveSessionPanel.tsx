import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import {
  buildAtlasExecutionNarrativeSummary,
  buildNarrativeSummary,
  type AtlasExecutionNarrativeFallback,
  type NarrativeStep,
  type NarrativeTone,
} from "./issue-live-session-narrative";
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
  atlasExecutionFallback?: AtlasExecutionNarrativeFallback | null;
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

function hasAtlasExecutionNarrativeFallback(fallback: AtlasExecutionNarrativeFallback | null | undefined): boolean {
  return Boolean(
    fallback?.headline
      || fallback?.currentState
      || fallback?.summary
      || fallback?.verifyStatus
      || fallback?.turnLabel
      || fallback?.nextStep
      || fallback?.evidenceUrl
      || fallback?.rawBody
      || fallback?.projectionWarning
      || fallback?.measuredObservations?.length
      || fallback?.recentMilestones?.length,
  );
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

function AtlasFactCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-3",
        tone === "success" && "border-emerald-500/25 bg-emerald-500/[0.05]",
        tone === "warning" && "border-amber-500/25 bg-amber-500/[0.06]",
        tone === "neutral" && "border-border/70 bg-background/45",
      )}
    >
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm leading-6 text-foreground">{value}</div>
    </div>
  );
}

function AtlasNarrativeDetails({
  fallback,
}: {
  fallback: AtlasExecutionNarrativeFallback;
}) {
  const verificationLine = fallback.verifierScope
    ? fallback.verifyStatus
      ? `${fallback.verifierScope} (${fallback.verifyStatus})`
      : fallback.verifierScope
    : fallback.verifyStatus;
  const primaryLimitation = fallback.verificationLimitations?.[0] ?? null;
  const topObservation = fallback.measuredObservations?.[0] ?? null;

  return (
    <div className="space-y-3">
      {fallback.projectionWarning ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-sm leading-6 text-amber-900 dark:text-amber-100">
          {fallback.projectionWarning}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        {fallback.turnLabel ? <AtlasFactCard label="Projected turn" value={fallback.turnLabel} /> : null}
        {fallback.currentState ? (
          <AtlasFactCard
            label="Current state"
            value={fallback.currentState}
            tone={fallback.verifyStatus === "passed" ? "success" : "neutral"}
          />
        ) : null}
        {verificationLine ? (
          <AtlasFactCard
            label="Verifier scope"
            value={verificationLine}
            tone={fallback.verifyStatus === "passed" ? "success" : "neutral"}
          />
        ) : null}
      </div>

      {fallback.executorSummary ? <AtlasFactCard label="Executor said" value={fallback.executorSummary} /> : null}
      {primaryLimitation ? <AtlasFactCard label="Still missing" value={primaryLimitation} tone="warning" /> : null}
      {topObservation ? <AtlasFactCard label="Top observation" value={topObservation} /> : null}

      {(fallback.standUrl || fallback.evidenceUrl) ? (
        <div className="flex flex-wrap gap-2">
          {fallback.standUrl ? (
            <a
              href={fallback.standUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-cyan-500/25 bg-cyan-500/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-700 transition-colors hover:bg-cyan-500/[0.14] dark:text-cyan-300"
            >
              Open stand
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          {fallback.evidenceUrl ? (
            <a
              href={fallback.evidenceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/[0.08] px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/[0.14] dark:text-emerald-300"
            >
              Open evidence
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AtlasSyntheticStream({
  fallback,
  mode,
}: {
  fallback: AtlasExecutionNarrativeFallback;
  mode: TranscriptMode;
}) {
  if (mode === "raw") {
    return (
      <pre className="overflow-x-auto rounded-xl border border-border/70 bg-background/55 p-4 text-xs leading-6 text-muted-foreground">
        {fallback.rawBody || "Raw Atlas execution document is not available."}
      </pre>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {fallback.headline ? <AtlasFactCard label="Headline" value={fallback.headline} /> : null}
        {fallback.summary ? <AtlasFactCard label="Summary" value={fallback.summary} /> : null}
        {fallback.turnLabel ? <AtlasFactCard label="Projected turn" value={fallback.turnLabel} /> : null}
        {fallback.currentState ? <AtlasFactCard label="Current state" value={fallback.currentState} /> : null}
      </div>

      <AtlasNarrativeDetails fallback={fallback} />

      {fallback.recentMilestones?.length ? (
        <div className="rounded-xl border border-border/70 bg-background/45 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Milestones
          </div>
          <div className="mt-3 space-y-3">
            {fallback.recentMilestones.map((milestone, index) => (
              <div key={`${milestone.role}-${milestone.title}-${index}`} className="rounded-xl border border-border/70 bg-background/65 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-foreground">
                    {milestone.role}
                  </span>
                  <span className="text-sm font-medium text-foreground">{milestone.title}</span>
                  {milestone.at ? <span className="text-xs text-muted-foreground">{milestone.at}</span> : null}
                </div>
                <div className="mt-2 text-sm leading-6 text-muted-foreground">{milestone.summary}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NarrativeRunSection({
  run,
  summary,
  atlasFallback,
}: {
  run: LiveRunForIssue;
  summary: ReturnType<typeof buildNarrativeSummary>;
  atlasFallback?: AtlasExecutionNarrativeFallback | null;
}) {
  const currentTone = toneStyles(summary.current?.tone ?? "info");
  const isSynthetic = isSyntheticAtlasRun(run);

  return (
    <div className="space-y-3">
      <div className={cn("rounded-2xl border px-4 py-4 shadow-[0_12px_32px_rgba(15,23,42,0.08)]", currentTone.card)}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn("rounded-full border text-[10px] uppercase tracking-[0.18em]", currentTone.badge)}>
            Current focus
          </Badge>
          {atlasFallback?.turnLabel ? (
            <Badge variant="outline" className="rounded-full border-border/70 bg-background/80 text-[10px] uppercase tracking-[0.16em]">
              {atlasFallback.turnLabel}
            </Badge>
          ) : null}
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

      {isSynthetic && atlasFallback ? <AtlasNarrativeDetails fallback={atlasFallback} /> : null}

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

export function IssueLiveSessionPanel({ issueId, companyId, atlasExecutionFallback }: IssueLiveSessionPanelProps) {
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
    if (deduped.size === 0 && hasAtlasExecutionNarrativeFallback(atlasExecutionFallback)) {
      const syntheticCreatedAt = atlasExecutionFallback?.updatedAt ?? "1970-01-01T00:00:00.000Z";
      deduped.set(`atlas-execution-summary:${issueId}:${syntheticCreatedAt}`, {
        id: `atlas-execution-summary:${issueId}:${syntheticCreatedAt}`,
        status: "succeeded",
        invocationSource: "atlas_execution",
        triggerDetail: "Atlas execution summary",
        startedAt: syntheticCreatedAt,
        finishedAt: syntheticCreatedAt,
        createdAt: syntheticCreatedAt,
        agentId: "atlas-execution",
        agentName: "Atlas execution",
        adapterType: "atlas_execution",
        issueId,
        syntheticSource: "atlas_execution",
        openable: false,
      });
    }
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activeRun, atlasExecutionFallback, issueId, liveRuns]);

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
              Execution narrative
            </div>
            <div className="mt-3 text-sm font-semibold">Latest turn, proof scope, and the stage story</div>
            <div className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              Narrative stays concise at the top. Full stream keeps the raw execution detail when you need to inspect the exact projection.
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
            const summary = isSynthetic && transcript.length === 0
              ? buildAtlasExecutionNarrativeSummary(atlasExecutionFallback, isActive)
              : buildNarrativeSummary(transcript, isActive);

            return (
              <section key={run.id} className="px-4 py-4">
                <RunHeader
                  run={run}
                  isActive={isActive}
                  isSynthetic={isSynthetic}
                  cancelling={cancellingRunIds.has(run.id)}
                  onCancel={() => handleCancelRun(run.id)}
                />
                <NarrativeRunSection
                  run={run}
                  summary={summary}
                  atlasFallback={isSynthetic ? atlasExecutionFallback : null}
                />
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
                  {isSynthetic && atlasExecutionFallback ? (
                    <AtlasSyntheticStream fallback={atlasExecutionFallback} mode={transcriptMode} />
                  ) : (
                    <RunTranscriptView
                      entries={transcript}
                      mode={transcriptMode}
                      density="compact"
                      streaming={isActive}
                      collapseStdout
                      emptyMessage={
                        hasOutputForRun(run.id)
                          ? "Waiting for transcript parsing..."
                          : "Waiting for run output..."
                      }
                    />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </TabsContent>
    </Tabs>
  );
}
