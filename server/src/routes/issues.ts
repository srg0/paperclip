import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  addIssueCommentSchema,
  createIssueAttachmentMetadataSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createIssueSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { pluginRegistryService } from "../services/plugin-registry.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const ATLAS_BRIDGE_PLUGIN_KEY = "homio.atlas-bridge";
const ATLAS_EXECUTION_DOCUMENT_KEY = "atlas-execution";
const COMMENT_REOPENABLE_ISSUE_STATUSES = new Set(["done", "cancelled", "completed", "closed", "in_review"]);
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});

type AtlasFollowupDispatchStatus = "accepted" | "blocked" | "not_applicable";

interface AtlasFollowupResponse {
  status: AtlasFollowupDispatchStatus;
  requestType: "followup" | "merge_request" | "directed_agent" | null;
  detail: string | null;
  turnNumber: number | null;
  turnLabel: string | null;
}

function extractAtlasTurnNumber(documentBody: string | null | undefined): number | null {
  if (typeof documentBody !== "string" || documentBody.trim().length === 0) {
    return null;
  }
  const match = documentBody.match(/(?:^|\n)\s*-?\s*Turn:\s*`?TURN\s+(\d+)`?/i);
  return match ? Number(match[1]) : null;
}

function extractFollowupTurnNumber(commentBody: string | null | undefined): number | null {
  if (typeof commentBody !== "string" || commentBody.trim().length === 0) {
    return null;
  }
  const match = commentBody.match(/(?:^|\n)\s*(?:##\s*)?Follow-up turn\s+(\d+)\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function isAtlasMergeRequestIntent(commentBody: string | null | undefined): boolean {
  if (typeof commentBody !== "string" || commentBody.trim().length === 0) {
    return false;
  }
  const normalized = commentBody
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  if (
    /(?:^|\s)не\s+(?:открывай|создавай|делай|make|open|create)\s+(?:mr|merge request)(?:$|\s)/u.test(normalized)
    || /(?:^|\s)без\s+(?:mr|merge request)(?:$|\s)/u.test(normalized)
  ) {
    return false;
  }
  return (
    /(?:^|\s)(?:открой|открывай|создай|создавай|сделай|делай)\s+(?:mr|merge request)(?:$|\s)/u.test(normalized)
    || /(?:^|\s)(?:open|create|make)\s+(?:mr|merge request)(?:$|\s)/u.test(normalized)
    || /(?:^|\s)merge request(?:$|\s)/u.test(normalized)
  );
}

function normalizeAgentMatcherText(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isDeliveryOrchestratorAgent(agent: {
  name?: string | null;
  title?: string | null;
  role?: string | null;
  urlKey?: string | null;
  status?: string | null;
}) {
  const status = normalizeAgentMatcherText(agent.status);
  if (status === "terminated" || status === "pending approval" || status === "pending_approval") {
    return false;
  }
  const urlKey = normalizeAgentMatcherText(agent.urlKey);
  if (urlKey === "delivery orchestrator") return true;
  return [
    normalizeAgentMatcherText(agent.name),
    normalizeAgentMatcherText(agent.title),
    normalizeAgentMatcherText(agent.role),
  ].some((value) => value.includes("delivery orchestrator"));
}

function isIssueCommentReopenableStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return COMMENT_REOPENABLE_ISSUE_STATUSES.has(normalized);
}

export function issueRoutes(
  db: Db,
  storage: StorageService,
  deps?: {
    workerManager?: Pick<PluginWorkerManager, "call" | "getWorker" | "isRunning">;
    pluginRegistry?: Pick<ReturnType<typeof pluginRegistryService>, "getByKey">;
  },
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const pluginRegistry = deps?.pluginRegistry ?? pluginRegistryService(db);
  const routinesSvc = routineService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  const MAX_ATLAS_COMMENT_IMAGE_INLINE_BYTES = Math.max(
    32 * 1024,
    Number(process.env.ATLAS_FOLLOWUP_INLINE_IMAGE_MAX_BYTES || 512 * 1024) || 512 * 1024,
  );
  const MAX_ATLAS_COMMENT_IMAGES = Math.max(
    1,
    Number(process.env.ATLAS_FOLLOWUP_MAX_IMAGES || 4) || 4,
  );

  function buildAbsoluteUrl(req: Request, pathname: string) {
    const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").trim() || "https";
    const host = String(req.get("x-forwarded-host") || req.get("host") || "").trim();
    if (!host) return pathname;
    return `${proto}://${host}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  }

  async function streamToBuffer(stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function extractMarkdownImageRefs(body: string) {
    const refs: Array<{ altText: string | null; rawUrl: string; attachmentId: string | null }> = [];
    const pattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
    for (const match of body.matchAll(pattern)) {
      const rawUrl = String(match[2] || "").trim();
      if (!rawUrl) continue;
      const attachmentMatch = rawUrl.match(/\/api\/attachments\/([^/]+)\/content/i);
      refs.push({
        altText: String(match[1] || "").trim() || null,
        rawUrl,
        attachmentId: attachmentMatch?.[1] ? String(attachmentMatch[1]).trim() : null,
      });
    }
    return refs;
  }

  async function resolveAtlasFollowupCommentContext(input: {
    req: Request;
    issueId: string;
    companyId: string;
    commentId: string;
    commentBody: string;
  }) {
    const markdownImageRefs = extractMarkdownImageRefs(input.commentBody);
    if (markdownImageRefs.length === 0) {
      return {
        enrichedBody: input.commentBody,
        commentImages: [] as Array<Record<string, unknown>>,
      };
    }

    const allAttachments = await svc.listAttachments(input.issueId);
    const attachmentById = new Map(
      allAttachments.map((attachment) => [attachment.id, withContentPath(attachment)]),
    );
    const commentAttachments = allAttachments
      .filter((attachment) => attachment.issueCommentId === input.commentId)
      .map((attachment) => withContentPath(attachment));
    type IssueAttachmentWithContentPath = (typeof commentAttachments)[number];
    const requestedAttachmentIds = new Set(
      markdownImageRefs
        .map((item) => item.attachmentId)
        .filter((item): item is string => Boolean(item)),
    );
    const requestedAttachments: IssueAttachmentWithContentPath[] = Array.from(requestedAttachmentIds)
      .map((attachmentId) => attachmentById.get(attachmentId))
      .filter((attachment): attachment is IssueAttachmentWithContentPath => attachment != null);
    const candidateAttachments = [
      ...commentAttachments,
      ...requestedAttachments,
    ];

    const images: Array<Record<string, unknown>> = [];
    const seenAttachmentIds = new Set<string>();
    for (const attachment of candidateAttachments) {
      if (images.length >= MAX_ATLAS_COMMENT_IMAGES) break;
      if (seenAttachmentIds.has(attachment.id)) continue;
      seenAttachmentIds.add(attachment.id);
      if (!String(attachment.contentType || "").toLowerCase().startsWith("image/")) continue;

      const matchingRef = markdownImageRefs.find((item) => item.attachmentId === attachment.id) ?? null;
      const absoluteUrl = buildAbsoluteUrl(input.req, attachment.contentPath);
      let inlineDataUrl: string | null = null;

      if ((attachment.byteSize ?? 0) > 0 && (attachment.byteSize ?? 0) <= MAX_ATLAS_COMMENT_IMAGE_INLINE_BYTES) {
        try {
          const object = await storage.getObject(input.companyId, attachment.objectKey);
          const body = await streamToBuffer(object.stream);
          inlineDataUrl = `data:${attachment.contentType || object.contentType || "application/octet-stream"};base64,${body.toString("base64")}`;
        } catch {
          inlineDataUrl = null;
        }
      }

      images.push({
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename ?? null,
        contentType: attachment.contentType ?? null,
        byteSize: attachment.byteSize ?? null,
        sha256: attachment.sha256 ?? null,
        contentPath: attachment.contentPath,
        absoluteUrl,
        sourceUrl: matchingRef?.rawUrl ?? attachment.contentPath,
        altText: matchingRef?.altText ?? null,
        inlineDataUrl,
      });
    }

    if (images.length === 0) {
      return {
        enrichedBody: input.commentBody,
        commentImages: images,
      };
    }

    const imageLines = images.map((image, index) => {
      const name = String(image.originalFilename || `comment-image-${index + 1}`).trim();
      const contentType = String(image.contentType || "image").trim();
      const absoluteUrl = String(image.absoluteUrl || "").trim();
      const altText = String(image.altText || "").trim();
      return `- ${name} (${contentType})${altText ? ` — ${altText}` : ""}: ${absoluteUrl}`;
    });

    return {
      enrichedBody: [
        input.commentBody,
        "",
        "Reference images from this comment:",
        ...imageLines,
      ].join("\n"),
      commentImages: images,
    };
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function assertAgentRunCheckoutOwnership(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== "in_progress" || issue.assigneeAgentId !== actorAgentId) {
      return true;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    if (!runToInterrupt) {
      const issueScopedRun = await heartbeat.getActiveRunForIssue(issue.id);
      if (issueScopedRun?.status === "running") {
        runToInterrupt = issueScopedRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  function buildDirectedIssueAckComment(targetAgentName: string) {
    return [
      `Принял follow-up. Это ${targetAgentName}.`,
      "Сейчас запускаю новый turn и вернусь сюда с живым статусом queued/running либо с явным blocker.",
    ].join("\n\n");
  }

  async function dispatchDirectedIssueComment(input: {
    issue: {
      id: string;
      companyId: string;
      identifier: string | null;
      title: string | null;
    };
    comment: {
      id: string;
      body: string;
    };
    actor: ReturnType<typeof getActorInfo>;
    targetAgentId: string;
    interruptedRunId?: string | null;
    source: "issue_comment_directed" | "issue_comment_reassign";
  }): Promise<AtlasFollowupResponse> {
    const targetAgent = await agentsSvc.getById(input.targetAgentId);
    const targetAgentName = targetAgent?.name?.trim() || "Agent";

    if (!targetAgent || targetAgent.companyId !== input.issue.companyId) {
      const detail = "Directed agent is missing or belongs to another company.";
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.followup_blocked",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          requestType: "directed_agent",
          targetAgentId: input.targetAgentId,
          source: input.source,
          commentId: input.comment.id,
          error: detail,
        },
      });
      return {
        status: "blocked",
        requestType: "directed_agent",
        detail,
        turnNumber: null,
        turnLabel: null,
      };
    }

    try {
      await heartbeat.wakeup(input.targetAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: {
          issueId: input.issue.id,
          commentId: input.comment.id,
          mutation: "comment",
          ...(input.interruptedRunId ? { interruptedRunId: input.interruptedRunId } : {}),
        },
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
        contextSnapshot: {
          issueId: input.issue.id,
          taskId: input.issue.id,
          commentId: input.comment.id,
          wakeCommentId: input.comment.id,
          wakeReason: "issue_commented",
          source: input.source === "issue_comment_reassign" ? "issue.comment.reassign" : "issue.comment.directed",
          directedCommentTargetId: input.targetAgentId,
          ...(input.interruptedRunId ? { interruptedRunId: input.interruptedRunId } : {}),
        },
      });

      const ackComment = await svc.addComment(
        input.issue.id,
        buildDirectedIssueAckComment(targetAgentName),
        { agentId: input.targetAgentId },
      );

      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "agent",
        actorId: input.targetAgentId,
        agentId: input.targetAgentId,
        runId: null,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          commentId: ackComment.id,
          bodySnippet: ackComment.body.slice(0, 120),
          identifier: input.issue.identifier,
          issueTitle: input.issue.title,
          source: "directed_followup_ack",
        },
      });

      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.followup_requested",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          requestType: "directed_agent",
          targetAgentId: input.targetAgentId,
          targetAgentName,
          source: input.source,
          commentId: input.comment.id,
          detail: `${targetAgentName} получил directed follow-up и должен ответить в этом чате.`,
        },
      });

      return {
        status: "accepted",
        requestType: "directed_agent",
        detail: `${targetAgentName} принял directed follow-up. Ждём queued/running сигнал и ответ в этом issue chat.`,
        turnNumber: null,
        turnLabel: null,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.followup_blocked",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          requestType: "directed_agent",
          targetAgentId: input.targetAgentId,
          targetAgentName,
          source: input.source,
          commentId: input.comment.id,
          error: errorMessage,
        },
      });
      return {
        status: "blocked",
        requestType: "directed_agent",
        detail: errorMessage,
        turnNumber: null,
        turnLabel: null,
      };
    }
  }

async function maybeTriggerAtlasFollowupFromComment(input: {
  req: Request;
  issue: {
    id: string;
    companyId: string;
  };
  commentId: string;
  commentBody: string;
  actor: ReturnType<typeof getActorInfo>;
}): Promise<{
  triggered: boolean;
  mergeRequestIntentHandled: boolean;
  mergeRequestError: string | null;
  suppressGenericWake: boolean;
  atlasFollowup: AtlasFollowupResponse;
}> {
  const wantsMergeRequest = isAtlasMergeRequestIntent(input.commentBody);
  const fallbackResult = {
    triggered: false,
    mergeRequestIntentHandled: false,
    mergeRequestError: null,
    suppressGenericWake: false,
    atlasFollowup: {
      status: "not_applicable" as const,
      requestType: null,
      detail: null,
      turnNumber: null,
      turnLabel: null,
    },
  };
  if (input.actor.actorType !== "user" || !deps?.workerManager) {
    return fallbackResult;
  }

  const executionDoc = await documentsSvc.getIssueDocumentByKey(input.issue.id, ATLAS_EXECUTION_DOCUMENT_KEY);
  if (!executionDoc?.body) {
    return fallbackResult;
  }

  const explicitTurn = extractFollowupTurnNumber(input.commentBody);
  const comments = explicitTurn
    ? null
    : await svc.listComments(input.issue.id, { order: "desc", limit: MAX_ISSUE_COMMENT_LIMIT });
  const historyTurn = comments
    ? comments.reduce<number | null>((maxTurn, comment) => {
      const turn = extractFollowupTurnNumber(comment?.body ?? null);
      if (!turn || !Number.isFinite(turn)) return maxTurn;
      return maxTurn === null ? turn : Math.max(maxTurn, turn);
    }, null)
    : null;
  const currentTurn = Math.max(
    extractAtlasTurnNumber(executionDoc.body) ?? 0,
    historyTurn ?? 0,
  ) || null;
  const nextTurn = explicitTurn
    ?? (currentTurn && Number.isFinite(currentTurn) ? currentTurn + 1 : null);
  const nextTurnLabel = nextTurn ? `TURN ${nextTurn}` : null;

  const plugin = await pluginRegistry.getByKey(ATLAS_BRIDGE_PLUGIN_KEY);
  if (!plugin || plugin.status !== "ready") {
    logger.warn(
      { issueId: input.issue.id, pluginKey: ATLAS_BRIDGE_PLUGIN_KEY, pluginStatus: plugin?.status ?? "missing" },
      "atlas follow-up requested from issue comment, but bridge plugin is not ready",
    );
    return wantsMergeRequest
      ? {
        triggered: false,
        mergeRequestIntentHandled: true,
        mergeRequestError: "Atlas Bridge plugin is not ready for merge-request creation",
        suppressGenericWake: true,
        atlasFollowup: {
          status: "blocked",
          requestType: "merge_request",
          detail: "Atlas Bridge plugin is not ready for merge-request creation",
          turnNumber: null,
          turnLabel: null,
        },
      }
      : {
        triggered: false,
        mergeRequestIntentHandled: false,
        mergeRequestError: null,
        suppressGenericWake: true,
        atlasFollowup: {
          status: "blocked",
          requestType: "followup",
          detail: "Atlas Bridge plugin is not ready, so the new Atlas turn was not dispatched.",
          turnNumber: nextTurn,
          turnLabel: nextTurnLabel,
        },
      };
  }

  if (!deps.workerManager.getWorker(plugin.id) || !deps.workerManager.isRunning(plugin.id)) {
    logger.warn(
      {
        issueId: input.issue.id,
        pluginKey: ATLAS_BRIDGE_PLUGIN_KEY,
        pluginId: plugin.id,
        pluginStatus: plugin.status,
      },
      "atlas follow-up requested from issue comment, but bridge worker is not running",
    );
    return wantsMergeRequest
      ? {
        triggered: false,
        mergeRequestIntentHandled: true,
        mergeRequestError: "Atlas Bridge worker is not running for merge-request creation",
        suppressGenericWake: true,
        atlasFollowup: {
          status: "blocked",
          requestType: "merge_request",
          detail: "Atlas Bridge worker is not running for merge-request creation",
          turnNumber: null,
          turnLabel: null,
        },
      }
      : {
        triggered: false,
        mergeRequestIntentHandled: false,
        mergeRequestError: null,
        suppressGenericWake: true,
        atlasFollowup: {
          status: "blocked",
          requestType: "followup",
          detail: "Atlas Bridge worker is not running, so the new Atlas turn was not dispatched.",
          turnNumber: nextTurn,
          turnLabel: nextTurnLabel,
        },
      };
  }
  const commentContext = wantsMergeRequest
    ? { enrichedBody: input.commentBody, commentImages: [] as Array<Record<string, unknown>> }
    : await resolveAtlasFollowupCommentContext({
      req: input.req,
      issueId: input.issue.id,
      companyId: input.issue.companyId,
      commentId: input.commentId,
      commentBody: input.commentBody,
    });

  try {
    await deps.workerManager.call(plugin.id, "performAction", {
      key: wantsMergeRequest
        ? "atlas-bridge-open-issue-merge-request"
        : "atlas-bridge-followup-issue-execution",
      params: wantsMergeRequest
        ? {
          issueId: input.issue.id,
          companyId: input.issue.companyId,
          commentId: input.commentId,
        }
        : {
          issueId: input.issue.id,
          companyId: input.issue.companyId,
          commentId: input.commentId,
          request: commentContext.enrichedBody,
          commentImages: commentContext.commentImages,
          deferInitialSync: true,
          ...(nextTurn ? { turnNumber: nextTurn, turnLabel: nextTurnLabel } : {}),
        },
      renderEnvironment: null,
    }, 15_000);
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: wantsMergeRequest ? "issue.mr_requested" : "issue.followup_requested",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        pluginKey: ATLAS_BRIDGE_PLUGIN_KEY,
        requestType: wantsMergeRequest ? "merge_request" : "followup",
        nextTurn,
        source: "issue_comment",
      },
    });
    return {
      triggered: !wantsMergeRequest,
      mergeRequestIntentHandled: wantsMergeRequest,
      mergeRequestError: null,
      suppressGenericWake: true,
      atlasFollowup: {
        status: "accepted",
        requestType: wantsMergeRequest ? "merge_request" : "followup",
        detail: wantsMergeRequest
          ? "Atlas принял запрос на создание merge request."
          : "Atlas принял новый follow-up и должен ответить в этом issue thread.",
        turnNumber: wantsMergeRequest ? null : nextTurn,
        turnLabel: wantsMergeRequest ? null : nextTurnLabel,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, issueId: input.issue.id, pluginKey: ATLAS_BRIDGE_PLUGIN_KEY },
      "failed to trigger atlas follow-up from issue comment",
    );
    if (wantsMergeRequest) {
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.mr_request_blocked",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          pluginKey: ATLAS_BRIDGE_PLUGIN_KEY,
          source: "issue_comment",
          commentId: input.commentId,
          error: errorMessage,
        },
      });
      return {
        triggered: false,
        mergeRequestIntentHandled: true,
        mergeRequestError: errorMessage,
        suppressGenericWake: true,
        atlasFollowup: {
          status: "blocked",
          requestType: "merge_request",
          detail: errorMessage,
          turnNumber: null,
          turnLabel: null,
        },
      };
    }
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.followup_blocked",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        pluginKey: ATLAS_BRIDGE_PLUGIN_KEY,
        source: "issue_comment",
        commentId: input.commentId,
        error: errorMessage,
        turnNumber: nextTurn,
      },
    });
    return {
      triggered: false,
      mergeRequestIntentHandled: false,
      mergeRequestError: null,
      suppressGenericWake: true,
      atlasFollowup: {
        status: "blocked",
        requestType: "followup",
        detail: errorMessage,
        turnNumber: nextTurn,
        turnLabel: nextTurnLabel,
      },
    };
  }
}

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }

    const result = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      q: req.query.q as string | undefined,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const [{ project, goal }, ancestors, mentionedProjectIds, documentPayload] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const [{ project, goal }, ancestors, commentCursor, wakeComment] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
    ]);

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id);
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    const doc = result.document;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
      },
    });

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const actor = getActorInfo(req);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        },
      });

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
      },
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  router.post("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId);
    }

    let defaultAssigneeAgentId: string | null = null;
    if (!req.body.assigneeAgentId && !req.body.assigneeUserId) {
      const companyAgents = await agentsSvc.list(companyId);
      defaultAssigneeAgentId = companyAgents.find((agent) => isDeliveryOrchestratorAgent(agent))?.id ?? null;
    }

    const actor = getActorInfo(req);
    const issue = await svc.create(companyId, {
      ...req.body,
      ...(defaultAssigneeAgentId ? { assigneeAgentId: defaultAssigneeAgentId } : {}),
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { title: issue.title, identifier: issue.identifier },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json(issue);
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const assigneeWillChange =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);

    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      req.body.assigneeAgentId === null &&
      typeof req.body.assigneeUserId === "string" &&
      !!existing.createdByUserId &&
      req.body.assigneeUserId === existing.createdByUserId;

    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;

    const actor = getActorInfo(req);
    const isClosed = isIssueCommentReopenableStatus(existing.status);
    const {
      comment: commentBody,
      commentTargetAgentId: commentTargetAgentIdRaw,
      reopen: reopenRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
    const directedCommentTargetId =
      commentBody && typeof commentTargetAgentIdRaw === "string" && commentTargetAgentIdRaw.trim().length > 0
        ? commentTargetAgentIdRaw.trim()
        : null;
    const directedCommentReassignment = Boolean(commentBody) && assigneeWillChange;
    const directedCommentRequested = Boolean(commentBody) && Boolean(directedCommentTargetId);
    const shouldInterruptForDirectedComment =
      (directedCommentRequested || directedCommentReassignment) &&
      req.actor.type === "board" &&
      interruptRequested !== true;
    let interruptedRunId: string | null = null;

    if (interruptRequested || shouldInterruptForDirectedComment) {
      if (!commentBody) {
        res.status(400).json({ error: "Interrupt is only supported when posting a comment" });
        return;
      }
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: existing.id },
          });
        }
      }
    }

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (commentBody && reopenRequested === true && isClosed && updateFields.status === undefined) {
      updateFields.status = "todo";
    }
    let issue;
    try {
      issue = await svc.update(id, updateFields);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    const reopened =
      commentBody &&
      reopenRequested === true &&
      isClosed &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        _previous: hasFieldChanges ? previous : undefined,
      },
    });

    let comment = null;
    let atlasFollowupTriggered = false;
    let atlasMergeRequestHandled = false;
    let atlasMergeRequestError: string | null = null;
    let atlasFollowup: AtlasFollowupResponse = {
      status: "not_applicable",
      requestType: null,
      detail: null,
      turnNumber: null,
      turnLabel: null,
    };
    if (commentBody) {
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
        },
      });

      if (!directedCommentRequested && !directedCommentReassignment) {
        const atlasCommentResult = await maybeTriggerAtlasFollowupFromComment({
          req,
          issue,
          commentId: comment.id,
          commentBody,
          actor,
        });
        atlasFollowupTriggered = atlasCommentResult.triggered;
        atlasMergeRequestHandled = atlasCommentResult.mergeRequestIntentHandled;
        atlasMergeRequestError = atlasCommentResult.mergeRequestError;
        atlasFollowup = atlasCommentResult.atlasFollowup;
      } else {
        const directTargetAgentId = directedCommentTargetId ?? issue.assigneeAgentId;
        if (directTargetAgentId) {
          atlasFollowup = await dispatchDirectedIssueComment({
            issue: {
              id: issue.id,
              companyId: issue.companyId,
              identifier: issue.identifier ?? null,
              title: issue.title ?? null,
            },
            comment: {
              id: comment.id,
              body: comment.body,
            },
            actor,
            targetAgentId: directTargetAgentId,
            interruptedRunId,
            source: directedCommentReassignment ? "issue_comment_reassign" : "issue_comment_directed",
          });
        }
      }

    }

    const shouldSkipGenericWake =
      atlasFollowupTriggered
      || atlasMergeRequestHandled
      || atlasFollowup.status === "blocked"
      || atlasFollowup.requestType === "directed_agent";

    const assigneeChanged = assigneeWillChange;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      req.body.status !== undefined;

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

      if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog" && !shouldSkipGenericWake) {
        if (commentBody && comment) {
          wakeups.set(issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: issue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: issue.id,
              taskId: issue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment.reassign",
              wakeReason: "issue_commented",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(issue.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
            payload: {
              issueId: issue.id,
              mutation: "update",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: issue.id,
              source: "issue.update",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId && !shouldSkipGenericWake) {
          wakeups.set(issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: issue.id,
              source: "issue.status_change",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
        });
      }

      if (commentBody && comment && !shouldSkipGenericWake) {
        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (wakeups.has(mentionedId)) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          wakeups.set(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    res.json({
      ...issue,
      comment,
      atlasFollowupTriggered,
      atlasMergeRequestHandled,
      atlasMergeRequestError,
      atlasFollowup,
      interruptedRunId,
    });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const interruptRequested = req.body.interrupt === true;
    const directedCommentTargetId =
      typeof req.body.commentTargetAgentId === "string" && req.body.commentTargetAgentId.trim().length > 0
        ? req.body.commentTargetAgentId.trim()
        : null;
    const isClosed = isIssueCommentReopenableStatus(issue.status);
    const shouldInterruptForDirectedComment =
      Boolean(directedCommentTargetId) &&
      req.actor.type === "board" &&
      interruptRequested !== true;
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;

    if (reopenRequested && isClosed) {
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested || shouldInterruptForDirectedComment) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    const atlasCommentResult = directedCommentTargetId
      ? {
        triggered: false,
        mergeRequestIntentHandled: false,
        mergeRequestError: null,
        suppressGenericWake: false,
        atlasFollowup: {
          status: "not_applicable" as const,
          requestType: null,
          detail: null,
          turnNumber: null,
          turnLabel: null,
        },
      }
      : await maybeTriggerAtlasFollowupFromComment({
        req,
        issue: currentIssue,
        commentId: comment.id,
        commentBody: req.body.body,
        actor,
      });
    const atlasFollowupTriggered = atlasCommentResult.triggered;
    const atlasMergeRequestHandled = atlasCommentResult.mergeRequestIntentHandled;
    const atlasMergeRequestError = atlasCommentResult.mergeRequestError;
    let atlasFollowup = atlasCommentResult.atlasFollowup;
    if (directedCommentTargetId) {
      atlasFollowup = await dispatchDirectedIssueComment({
        issue: {
          id: currentIssue.id,
          companyId: currentIssue.companyId,
          identifier: currentIssue.identifier ?? null,
          title: currentIssue.title ?? null,
        },
        comment: {
          id: comment.id,
          body: comment.body,
        },
        actor,
        targetAgentId: directedCommentTargetId,
        interruptedRunId,
        source: "issue_comment_directed",
      });
    }
    const shouldSkipGenericWake =
      atlasFollowupTriggered
      || atlasMergeRequestHandled
      || atlasCommentResult.suppressGenericWake
      || atlasFollowup.requestType === "directed_agent";

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && !shouldSkipGenericWake && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      if (!shouldSkipGenericWake) {
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, req.body.body);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    res.status(201).json({
      ...currentIssue,
      comment,
      atlasFollowupTriggered,
      atlasMergeRequestHandled,
      atlasMergeRequestError,
      atlasFollowup,
      interruptedRunId,
    });
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    res.setHeader("Content-Type", attachment.contentType || object.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    const filename = attachment.originalFilename ?? "attachment";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
