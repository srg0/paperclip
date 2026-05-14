import type { ExecutionWorkspace } from "@paperclipai/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pluginsApi } from "../../api/plugins";

const ATLAS_BRIDGE_PLUGIN_ID = "homio.atlas-bridge";
const ATLAS_BRIDGE_KANNA_EMBED_KEY = "atlas-bridge-kanna-embed";
const ATLAS_BRIDGE_ISSUE_EXECUTION_KEY = "atlas-bridge-issue-execution";
const KANNA_ROLE_OPTIONS = [
  { key: "atlas_executor", label: "Executor", icon: Bot },
  { key: "technical_verifier", label: "Verifier", icon: ShieldCheck },
] as const;

type AtlasKannaEmbedData = {
  enabled?: boolean;
  reason?: string | null;
  message?: string | null;
  embedUrl?: string | null;
  chatId?: string | null;
  envName?: string | null;
  branch?: string | null;
};

type AtlasBridgeEvidenceItem = {
  label?: string | null;
  url?: string | null;
  kind?: string | null;
  score?: string | null;
  description?: string | null;
  runtimeSurface?: string | null;
};

type AtlasIssueExecutionData = {
  currentExecution?: {
    envName?: string | null;
    branch?: string | null;
    attachmentState?: string | null;
  } | null;
  envelope?: {
    slot?: {
      envName?: string | null;
    } | null;
  } | null;
  human?: {
    evidence?: AtlasBridgeEvidenceItem[] | null;
    verifyStatus?: string | null;
    scenarioStatus?: string | null;
    nextStep?: string | null;
    standUrl?: string | null;
    reviewProofSatisfied?: boolean | null;
  } | null;
};

type StableKannaFrameState = {
  identity: string;
  src: string;
};

type IssueKannaSurfaceProps = {
  issueId: string;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  companyId: string;
  projectId?: string | null;
  projectKey?: string | null;
  projectName?: string | null;
  executionWorkspace?: ExecutionWorkspace | null;
  issueStatus?: string | null;
  enabled: boolean;
  fallback: ReactNode;
};

function normalizeKannaEmbedIdentity(
  embedUrl: string | null,
  embed: AtlasKannaEmbedData | null | undefined,
  issueId: string,
  processAgentKey: string,
): string | null {
  if (!embedUrl) return null;
  const chatId = typeof embed?.chatId === "string" && embed.chatId.trim() ? embed.chatId.trim() : null;
  const envName = typeof embed?.envName === "string" && embed.envName.trim() ? embed.envName.trim() : null;
  const branch = typeof embed?.branch === "string" && embed.branch.trim() ? embed.branch.trim() : null;
  try {
    const url = new URL(embedUrl);
    url.searchParams.delete("kannaEmbedToken");
    return [issueId, processAgentKey, chatId ?? url.pathname, envName ?? "", branch ?? "", url.origin].join("|");
  } catch {
    const tokenlessUrl = embedUrl.replace(/([?&])kannaEmbedToken=[^&]+/, "$1");
    return [issueId, processAgentKey, chatId ?? tokenlessUrl, envName ?? "", branch ?? ""].join("|");
  }
}

function normalizeEvidenceItems(items: AtlasBridgeEvidenceItem[] | null | undefined): AtlasBridgeEvidenceItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : null,
      url: typeof item.url === "string" && item.url.trim() ? item.url.trim() : null,
      kind: typeof item.kind === "string" && item.kind.trim() ? item.kind.trim() : null,
      score: typeof item.score === "string" && item.score.trim() ? item.score.trim() : null,
      description: typeof item.description === "string" && item.description.trim() ? item.description.trim() : null,
      runtimeSurface: typeof item.runtimeSurface === "string" && item.runtimeSurface.trim() ? item.runtimeSurface.trim() : null,
    }))
    .filter((item) => item.url)
    .slice(0, 8);
}

function evidenceScoreLabel(items: AtlasBridgeEvidenceItem[]): string {
  if (!items.length) return "none";
  if (items.some((item) => item.score === "strong")) return "strong";
  if (items.some((item) => item.score === "medium")) return "medium";
  return "weak";
}

export function IssueKannaSurface({
  issueId,
  issueIdentifier,
  issueTitle,
  companyId,
  projectId,
  projectKey,
  projectName,
  executionWorkspace,
  issueStatus,
  enabled,
  fallback,
}: IssueKannaSurfaceProps) {
  const defaultProcessAgentKey = issueStatus === "in_review" ? "technical_verifier" : "atlas_executor";
  const [selectedProcessAgentKey, setSelectedProcessAgentKey] = useState(defaultProcessAgentKey);

  useEffect(() => {
    setSelectedProcessAgentKey(defaultProcessAgentKey);
  }, [defaultProcessAgentKey, issueId]);

  const kannaEmbedQuery = useQuery({
    queryKey: [
      "atlas-bridge-kanna-embed",
      companyId,
      issueId,
      selectedProcessAgentKey,
      issueIdentifier ?? null,
      issueTitle ?? null,
      executionWorkspace?.id ?? null,
      executionWorkspace?.cwd ?? null,
      executionWorkspace?.branchName ?? null,
      projectId ?? null,
      projectKey ?? null,
      projectName ?? null,
    ],
    enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(
        ATLAS_BRIDGE_PLUGIN_ID,
        ATLAS_BRIDGE_KANNA_EMBED_KEY,
        {
          issueId,
          issueIdentifier: issueIdentifier ?? null,
          issueTitle: issueTitle ?? null,
          projectId: projectId ?? null,
          projectKey: projectKey ?? null,
          projectName: projectName ?? null,
          executionWorkspaceId: executionWorkspace?.id ?? null,
          workspaceName: executionWorkspace?.name ?? null,
          workspaceRepoUrl: executionWorkspace?.repoUrl ?? null,
          workspaceBranch: executionWorkspace?.branchName ?? null,
          workspaceCwd: executionWorkspace?.cwd ?? null,
          processAgentKey: selectedProcessAgentKey,
        },
        companyId,
        null,
      );
      return (response.data ?? null) as AtlasKannaEmbedData | null;
    },
  });

  const issueExecutionQuery = useQuery({
    queryKey: [
      "atlas-bridge-issue-execution",
      companyId,
      issueId,
      executionWorkspace?.id ?? null,
    ],
    enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(
        ATLAS_BRIDGE_PLUGIN_ID,
        ATLAS_BRIDGE_ISSUE_EXECUTION_KEY,
        { issueId },
        companyId,
        null,
      );
      return (response.data ?? null) as AtlasIssueExecutionData | null;
    },
  });

  const embed = kannaEmbedQuery.data;
  const embedUrl = typeof embed?.embedUrl === "string" ? embed.embedUrl : null;
  const embedIdentity = useMemo(
    () => normalizeKannaEmbedIdentity(embedUrl, embed, issueId, selectedProcessAgentKey),
    [embed, embedUrl, issueId, selectedProcessAgentKey],
  );
  const [stableFrame, setStableFrame] = useState<StableKannaFrameState | null>(null);

  useEffect(() => {
    if (!embed?.enabled || !embedUrl || !embedIdentity) return;
    setStableFrame((current) => {
      if (current?.identity === embedIdentity) return current;
      return { identity: embedIdentity, src: embedUrl };
    });
  }, [embed?.enabled, embedIdentity, embedUrl]);

  const nextFrame =
    embed?.enabled && embedUrl && embedIdentity
      ? { identity: embedIdentity, src: embedUrl }
      : null;
  const activeStableFrame = stableFrame?.identity === embedIdentity ? stableFrame : nextFrame;
  const showKanna = Boolean(embed?.enabled && activeStableFrame?.src);
  const safeEmbedUrl = activeStableFrame?.src;
  const latestOpenUrl = embedUrl ?? safeEmbedUrl;
  const issueExecution = issueExecutionQuery.data;
  const evidenceItems = normalizeEvidenceItems(issueExecution?.human?.evidence);
  const scoreLabel = evidenceScoreLabel(evidenceItems);
  const runtimeSurface =
    issueExecution?.human?.standUrl
    ?? issueExecution?.currentExecution?.envName
    ?? issueExecution?.envelope?.slot?.envName
    ?? embed?.envName
    ?? "Atlas workspace";
  const verifyStatus = issueExecution?.human?.verifyStatus ?? "none";

  if (!enabled) {
    return <>{fallback}</>;
  }

  if (kannaEmbedQuery.isLoading) {
    return (
      <div className="rounded-3xl border border-border bg-card/80 p-6 shadow-sm">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting chat to the current Atlas workspace…
        </div>
      </div>
    );
  }

  if (!showKanna) {
    return (
      <div className="space-y-4">
        <div className="rounded-3xl border border-border bg-card/80 p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="text-sm font-semibold text-foreground">Chat surface is not available yet</div>
              <p className="text-sm text-muted-foreground">
                {embed?.message ?? "Atlas has not mounted a live workspace for this issue yet."}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void kannaEmbedQuery.refetch();
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </div>
        </div>
        {fallback}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="issue-kanna-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card/60 px-4 py-3">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-foreground">Agent session</div>
          <div className="text-xs text-muted-foreground">
            {embed?.envName ? `Workspace ${embed.envName}` : "Atlas workspace"}
            {embed?.branch ? ` · ${embed.branch}` : ""}
          </div>
        </div>
        <div className="inline-flex rounded-full border border-border bg-background/80 p-1" role="tablist" aria-label="Kanna process role">
          {KANNA_ROLE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = selectedProcessAgentKey === option.key;
            return (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelectedProcessAgentKey(option.key)}
                className={[
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                  active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            );
          })}
        </div>
        <a
          href={latestOpenUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/30"
        >
          Open in Atlas
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <details className="rounded-2xl border border-border bg-card/60 px-4 py-3" open={evidenceItems.length > 0}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          <span>Evidence</span>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            score: {scoreLabel}
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            verify: {verifyStatus}
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            surface: {runtimeSurface}
          </span>
        </summary>
        <div className="mt-3 grid gap-2">
          {evidenceItems.length ? evidenceItems.map((item, index) => (
            <a
              key={`${item.url}:${index}`}
              href={item.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-border bg-background/70 px-3 py-2 text-sm transition-colors hover:bg-accent/30"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{item.label ?? item.kind ?? item.url}</span>
                {item.score ? <span className="text-xs text-muted-foreground">score: {item.score}</span> : null}
                {item.kind ? <span className="text-xs text-muted-foreground">type: {item.kind}</span> : null}
              </div>
              {item.description ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</div> : null}
            </a>
          )) : (
            <div className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              No evidence published for this issue yet.
            </div>
          )}
        </div>
      </details>

      <div className="overflow-hidden rounded-[28px] border border-border bg-background shadow-sm">
        <iframe
          title={`Agent chat for issue ${issueId}`}
          src={safeEmbedUrl}
          data-kanna-chat-id={embed?.chatId ?? undefined}
          data-kanna-embed-identity={activeStableFrame?.identity}
          className="h-[calc(100vh-22rem)] min-h-[720px] w-full border-0 bg-background"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
