import type { ExecutionWorkspace } from "@paperclipai/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pluginsApi } from "../../api/plugins";

const ATLAS_BRIDGE_PLUGIN_ID = "homio.atlas-bridge";
const ATLAS_BRIDGE_KANNA_EMBED_KEY = "atlas-bridge-kanna-embed";

type AtlasKannaEmbedData = {
  enabled?: boolean;
  reason?: string | null;
  message?: string | null;
  embedUrl?: string | null;
  chatId?: string | null;
  envName?: string | null;
  branch?: string | null;
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
  enabled: boolean;
  fallback: ReactNode;
};

function normalizeKannaEmbedIdentity(
  embedUrl: string | null,
  embed: AtlasKannaEmbedData | null | undefined,
  issueId: string,
): string | null {
  if (!embedUrl) return null;
  const chatId = typeof embed?.chatId === "string" && embed.chatId.trim() ? embed.chatId.trim() : null;
  const envName = typeof embed?.envName === "string" && embed.envName.trim() ? embed.envName.trim() : null;
  const branch = typeof embed?.branch === "string" && embed.branch.trim() ? embed.branch.trim() : null;
  try {
    const url = new URL(embedUrl);
    url.searchParams.delete("kannaEmbedToken");
    return [issueId, chatId ?? url.pathname, envName ?? "", branch ?? "", url.origin].join("|");
  } catch {
    const tokenlessUrl = embedUrl.replace(/([?&])kannaEmbedToken=[^&]+/, "$1");
    return [issueId, chatId ?? tokenlessUrl, envName ?? "", branch ?? ""].join("|");
  }
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
  enabled,
  fallback,
}: IssueKannaSurfaceProps) {
  const kannaEmbedQuery = useQuery({
    queryKey: [
      "atlas-bridge-kanna-embed",
      companyId,
      issueId,
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
        },
        companyId,
        null,
      );
      return (response.data ?? null) as AtlasKannaEmbedData | null;
    },
  });

  const embed = kannaEmbedQuery.data;
  const embedUrl = typeof embed?.embedUrl === "string" ? embed.embedUrl : null;
  const embedIdentity = useMemo(
    () => normalizeKannaEmbedIdentity(embedUrl, embed, issueId),
    [embed, embedUrl, issueId],
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
