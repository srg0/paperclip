import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn, relativeTime } from "@/lib/utils";
import type { IssueExecutionHeaderModel, IssueExecutionHeaderStage, IssueExecutionStageState } from "@/lib/issue-execution-flow";
import { ChevronDown, ExternalLink, GitBranch, GitCommitHorizontal, RefreshCw, TimerReset } from "lucide-react";

function stateClasses(state: IssueExecutionStageState) {
  switch (state) {
    case "passed":
      return "border-emerald-500/30 bg-emerald-500 text-white";
    case "running":
      return "border-cyan-500/40 bg-cyan-500 text-white";
    case "retrying":
      return "border-amber-500/40 bg-amber-500 text-white";
    case "looping":
      return "border-violet-500/40 bg-violet-500 text-white";
    case "blocked":
      return "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "failed":
      return "border-red-500/40 bg-red-500 text-white";
    case "skipped":
      return "border-border/60 bg-muted text-muted-foreground";
    default:
      return "border-border/70 bg-background text-muted-foreground";
  }
}

function chipClasses(tone: IssueExecutionHeaderModel["flowSeverity"]) {
  switch (tone) {
    case "success":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "warning":
      return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "error":
      return "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return "border-border/70 bg-muted/30 text-muted-foreground";
  }
}

function summaryChip(label: string, value: string, tone: IssueExecutionHeaderModel["flowSeverity"] = "neutral") {
  return (
    <div className={cn("rounded-xl border px-3 py-2", chipClasses(tone))}>
      <div className="text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="mt-1 text-sm font-medium leading-5">{value}</div>
    </div>
  );
}

function StageDot({ stage, isLast }: { stage: IssueExecutionHeaderStage; isLast: boolean }) {
  const active = stage.state === "running" || stage.state === "retrying" || stage.state === "looping";
  return (
    <div className="flex min-w-[116px] flex-1 items-start gap-3">
      <div className="flex flex-1 items-start gap-3">
        <div className="flex flex-col items-center pt-0.5">
          <div
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-full border text-[11px] font-semibold shadow-sm transition-colors",
              stateClasses(stage.state),
            )}
          >
            {active ? (
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-current opacity-20" />
            ) : null}
            <span className="relative z-10">{stage.label.slice(0, 1)}</span>
          </div>
          {stage.countBadge ? (
            <span className="mt-1 rounded-full border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {stage.countBadge}
            </span>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{stage.label}</div>
          <div className="text-xs text-muted-foreground">{stage.ownerLabel}</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{stage.state.replace("_", " ")}</div>
          {stage.note ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{stage.note}</div> : null}
        </div>
      </div>
      {!isLast ? (
        <div className="mt-4 h-px flex-1 rounded-full bg-border/80">
          {active ? <div className="h-px w-16 animate-pulse rounded-full bg-cyan-500" /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function IssueExecutionHeader({
  model,
  issueKey,
  issueStatus,
}: {
  model: IssueExecutionHeaderModel;
  issueKey: string;
  issueStatus: string;
}) {
  return (
    <section
      data-testid="issue-execution-header"
      className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-[0_26px_80px_-44px_rgba(15,23,42,0.5)]"
    >
      <div className="border-b border-border/70 bg-gradient-to-r from-background via-background to-cyan-500/[0.04] px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground">
            {issueKey}
          </span>
          <span className="rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 text-xs font-medium text-foreground">
            {issueStatus}
          </span>
          <span className="rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 text-xs font-medium text-foreground">
            {model.executionStateLabel}
          </span>
          {model.standLabel ? (
            <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-700 dark:text-cyan-300">
              {model.standLabel}
            </span>
          ) : null}
          {model.elapsedLabel ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground">
              <TimerReset className="h-3 w-3" />
              {model.elapsedLabel}
            </span>
          ) : null}
          {model.lastUpdatedAt ? (
            <span className="ml-auto text-xs text-muted-foreground">
              Updated {relativeTime(model.lastUpdatedAt)}
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <GitCommitHorizontal className="mt-0.5 h-4 w-4 text-cyan-500" />
            <div className="min-w-0">
              <div className="text-base font-semibold text-foreground">
                {model.headline ?? "Execution overview"}
              </div>
              <div className="mt-1 text-sm leading-6 text-muted-foreground">
                {model.summary ?? "Bridge summary is not available yet. The header is showing projected execution state."}
              </div>
            </div>
          </div>

          {model.mismatchText ? (
            <div className={cn("rounded-xl border px-3 py-2 text-sm", chipClasses(model.flowSeverity))}>
              {model.mismatchText}
            </div>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto border-b border-border/70 px-4 py-4 sm:px-5">
        <div data-testid="issue-execution-stage-rail" className="flex min-w-[720px] items-start gap-2">
          {model.stages.map((stage, index) => (
            <div key={stage.key} data-testid={`issue-execution-stage-${stage.key}`} className="flex flex-1">
              <StageDot stage={stage} isLast={index === model.stages.length - 1} />
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 border-b border-border/70 px-4 py-4 sm:grid-cols-2 xl:grid-cols-6 sm:px-5">
        {summaryChip("Current agent", model.currentAgent)}
        {summaryChip("Expected next", model.expectedNext)}
        {summaryChip("Actual next observed", model.actualNextObserved, model.flowSeverity)}
        {summaryChip("Turn", model.turnLabel)}
        {summaryChip("Loop", model.loopLabel)}
        {summaryChip("Retry", model.retryLabel)}
      </div>

      <Collapsible defaultOpen className="px-4 py-4 sm:px-5">
        <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
          <div>
            <div className="text-sm font-semibold text-foreground">Execution drill-down</div>
            <div className="text-xs text-muted-foreground">
              Next step, recent milestones, and the exact status story for this lineage.
            </div>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-3">
              <div className="rounded-xl border border-border/70 bg-background/60 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <GitBranch className="h-3.5 w-3.5" />
                  Flow status
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {summaryChip("Status", model.flowStatus, model.flowSeverity)}
                  {summaryChip("Next step", model.nextStep ?? "Pending projection")}
                </div>
              </div>

              <div className="rounded-xl border border-border/70 bg-background/60 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Recent milestones
                </div>
                <div className="mt-3 space-y-3">
                  {model.milestones.length ? model.milestones.map((milestone, index) => (
                    <div key={`${milestone.role}-${milestone.title}-${index}`} className="rounded-xl border border-border/70 bg-background px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-foreground">
                          {milestone.role}
                        </span>
                        <span className="text-sm font-medium text-foreground">{milestone.title}</span>
                        {milestone.at ? <span className="text-xs text-muted-foreground">{milestone.at}</span> : null}
                      </div>
                      <div className="mt-2 text-sm leading-6 text-muted-foreground">{milestone.summary}</div>
                    </div>
                  )) : (
                    <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                      No human-readable milestones yet. Execution is still being projected.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              {model.standUrl ? (
                <a
                  href={model.standUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-700 transition-colors hover:bg-cyan-500/15 dark:text-cyan-300"
                >
                  <span>Open stand</span>
                  <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}
              {model.evidenceUrl ? (
                <a
                  href={model.evidenceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
                >
                  <span>Open evidence PNG</span>
                  <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}

              <div className="rounded-xl border border-border/70 bg-background/60 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Execution notes
                </div>
                <div className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                  <div>Current agent: <span className="font-medium text-foreground">{model.currentAgent}</span></div>
                  <div>Expected next: <span className="font-medium text-foreground">{model.expectedNext}</span></div>
                  <div>Actual next observed: <span className="font-medium text-foreground">{model.actualNextObserved}</span></div>
                  <div>Motion contract: only active stage pulses; completed stages stay static.</div>
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
