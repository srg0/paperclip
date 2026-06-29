import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AtSign, GitPullRequestArrow, Paperclip, Square } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentIcon } from "../AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "../MarkdownEditor";

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

type SlashCommandId = "mr" | "cancel";

interface IssueConversationComposerProps {
  onAdd: (
    body: string,
    reopen?: boolean,
    reassignment?: CommentReassignment,
    commentTargetAgentId?: string | null,
    options?: { interrupt?: boolean },
  ) => Promise<void>;
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<void>;
  composerStatusSlot?: React.ReactNode;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  draftKey?: string;
  issueStatus?: string | null;
  simpleMode?: boolean;
  fixedCommentTargetAgentId?: string | null;
  primaryAgentLabel?: string;
}

interface SlashCommandDefinition {
  id: SlashCommandId | "mention" | "attach";
  label: string;
  command: string;
  description: string;
  group: "Task Commands" | "Composer Controls";
}

const TASK_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    id: "mr",
    label: "Create Merge Request",
    command: "/mr",
    description: "Routes a merge request intent through the existing issue comment path.",
    group: "Task Commands",
  },
  {
    id: "cancel",
    label: "Interrupt Active Run",
    command: "/cancel",
    description: "Interrupts the active run before your next turn continues.",
    group: "Task Commands",
  },
];

const COMPOSER_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    id: "mention",
    label: "Mention Agent Or Project",
    command: "/mention",
    description: "Inserts @ so you can target an agent or project with the current turn.",
    group: "Composer Controls",
  },
  {
    id: "attach",
    label: "Attach Image",
    command: "/attach",
    description: "Opens the existing image attach flow without leaving the composer.",
    group: "Composer Controls",
  },
];

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled", "completed", "closed", "in_review"]);
const COMMENT_MODEL_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.2", label: "GPT-5.2" },
];
const COMMENT_REASONING_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const COMPOSER_META_MARKER = "paperclip-compose";

function parseReassignment(target: string): CommentReassignment | null {
  if (!target || target === "__none__") {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (target.startsWith("agent:")) {
    const assigneeAgentId = target.slice("agent:".length);
    return assigneeAgentId ? { assigneeAgentId, assigneeUserId: null } : null;
  }
  if (target.startsWith("user:")) {
    const assigneeUserId = target.slice("user:".length);
    return assigneeUserId ? { assigneeAgentId: null, assigneeUserId } : null;
  }
  return null;
}

function resolveSlashQuery(value: string): string | null {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  return firstToken.slice(1).toLowerCase();
}

function readComposerDraft(draftKey?: string): string {
  if (!draftKey) return "";
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function buildComposerBody(params: {
  body: string;
  model: string;
  reasoning: string;
}) {
  const trimmed = params.body.trim();
  if (!trimmed) return "";
  if (params.model === "auto" && params.reasoning === "auto") {
    return trimmed;
  }
  return `<!-- ${COMPOSER_META_MARKER}: ${JSON.stringify({
    model: params.model,
    reasoning: params.reasoning,
  })} -->\n${trimmed}`;
}

export function IssueConversationComposer({
  onAdd,
  imageUploadHandler,
  onAttachImage,
  composerStatusSlot,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  agentMap,
  draftKey,
  issueStatus,
  simpleMode = false,
  fixedCommentTargetAgentId = null,
  primaryAgentLabel = "Atlas Executor",
}: IssueConversationComposerProps) {
  const [body, setBody] = useState(() => readComposerDraft(draftKey));
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [selectedModel, setSelectedModel] = useState("auto");
  const [selectedReasoning, setSelectedReasoning] = useState("auto");
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const shouldAutoReopen = TERMINAL_ISSUE_STATUSES.has((issueStatus ?? "").toLowerCase());

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  useEffect(() => {
    if (!draftKey) return;
    try {
      if (body) {
        localStorage.setItem(draftKey, body);
      } else {
        localStorage.removeItem(draftKey);
      }
    } catch {
      // Ignore draft persistence failures.
    }
  }, [body, draftKey]);

  const slashQuery = simpleMode ? null : resolveSlashQuery(body);
  const slashOptions = slashQuery === null
    ? []
    : [...TASK_SLASH_COMMANDS, ...((imageUploadHandler || onAttachImage || mentions.length > 0 || enableReassign) ? COMPOSER_SLASH_COMMANDS : [])]
      .filter((command) => {
        const haystack = `${command.command} ${command.label} ${command.description}`.toLowerCase();
        return haystack.includes(slashQuery);
      });

  async function applyComposerCommand(commandId: "mention" | "attach") {
    if (commandId === "mention") {
      setBody("@");
      editorRef.current?.focus();
      return;
    }
    setBody("");
    attachInputRef.current?.click();
  }

  async function submitSlashCommand(commandId: SlashCommandId) {
    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : null;
    const directedAgentTargetId = fixedCommentTargetAgentId
      ?? (enableReassign && reassignTarget.startsWith("agent:") ? reassignTarget.slice("agent:".length) : null);

    setSubmitting(true);
    try {
      if (commandId === "mr") {
        await onAdd("сделай mr", shouldAutoReopen ? true : undefined, reassignment ?? undefined, directedAgentTargetId);
      } else if (commandId === "cancel") {
        await onAdd(
          "Останови текущий запуск и продолжи с новым turn.",
          shouldAutoReopen ? true : undefined,
          reassignment ?? undefined,
          directedAgentTargetId,
          { interrupt: true },
        );
      }
      setBody("");
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } finally {
      setSubmitting(false);
    }
  }

  async function executeSlashCommand(commandId: SlashCommandDefinition["id"]) {
    if (commandId === "mr" || commandId === "cancel") {
      await submitSlashCommand(commandId);
      return;
    }
    await applyComposerCommand(commandId);
  }

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!simpleMode && trimmed === "/mr") {
      await submitSlashCommand("mr");
      return;
    }
    if (!simpleMode && trimmed === "/cancel") {
      await submitSlashCommand("cancel");
      return;
    }
    if (!simpleMode && trimmed === "/mention") {
      await applyComposerCommand("mention");
      return;
    }
    if (!simpleMode && trimmed === "/attach") {
      await applyComposerCommand("attach");
      return;
    }

    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : null;
    const directedAgentTargetId = fixedCommentTargetAgentId
      ?? (enableReassign && reassignTarget.startsWith("agent:") ? reassignTarget.slice("agent:".length) : null);

    setSubmitting(true);
    try {
      await onAdd(
        buildComposerBody({
          body: trimmed,
          model: selectedModel,
          reasoning: selectedReasoning,
        }),
        shouldAutoReopen ? true : undefined,
        reassignment ?? undefined,
        directedAgentTargetId,
      );
      setBody("");
      setReassignTarget(effectiveSuggestedAssigneeValue);
      editorRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      if (imageUploadHandler) {
        const url = await imageUploadHandler(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
      } else if (onAttachImage) {
        await onAttachImage(file);
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const canSubmit = !submitting && !!body.trim();
  const directedAgentOption =
    enableReassign && reassignTarget.startsWith("agent:")
      ? reassignOptions.find((option) => option.id === reassignTarget) ?? null
      : null;

  return (
    <section
      className="codex-issue-surface rounded-2xl border border-border/70 bg-background/90 p-3.5 shadow-[var(--codex-surface-shadow)]"
      data-testid="issue-conversation-composer"
    >
      <div className="space-y-3">
        <div data-testid="issue-conversation-editor">
          <MarkdownEditor
            ref={editorRef}
            value={body}
            onChange={setBody}
            placeholder={simpleMode ? `Tell ${primaryAgentLabel} what should happen next...` : "Tell the task what should happen next... Use / for commands."}
            mentions={mentions}
            onSubmit={handleSubmit}
            imageUploadHandler={imageUploadHandler}
            contentClassName="min-h-[140px] text-[15px] leading-7"
          />
        </div>

        {slashQuery !== null ? (
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/95 shadow-[var(--codex-surface-shadow)] animate-in fade-in slide-in-from-bottom-2 duration-300">
            <Command>
              <CommandInput value={`/${slashQuery}`} readOnly />
              <CommandList>
                <CommandEmpty>No matching commands.</CommandEmpty>
                {(["Task Commands", "Composer Controls"] as const).map((group) => {
                  const commands = slashOptions.filter((command) => command.group === group);
                  if (commands.length === 0) return null;
                  return (
                    <CommandGroup key={group} heading={group}>
                      {commands.map((command) => (
                        <CommandItem
                          key={command.id}
                          onSelect={() => void executeSlashCommand(command.id)}
                          className="flex items-start gap-3"
                        >
                          {command.id === "mr" ? (
                            <GitPullRequestArrow className="mt-0.5 h-4 w-4" />
                          ) : command.id === "cancel" ? (
                            <Square className="mt-0.5 h-4 w-4" />
                          ) : command.id === "mention" ? (
                            <AtSign className="mt-0.5 h-4 w-4" />
                          ) : (
                            <Paperclip className="mt-0.5 h-4 w-4" />
                          )}
                          <div className="min-w-0">
                            <div className="text-[12px] font-medium">{command.command} {command.label}</div>
                            <div className="text-[11px] text-muted-foreground">{command.description}</div>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  );
                })}
              </CommandList>
            </Command>
          </div>
        ) : null}

        {composerStatusSlot}

        <div className="flex flex-wrap items-center gap-3">
          {(imageUploadHandler || onAttachImage) && (
            <div className="mr-auto flex items-center gap-3">
              <input
                ref={attachInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                title="Attach image"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
          )}

          {simpleMode ? (
            <span
              data-testid="issue-primary-agent-chip"
              className="inline-flex items-center rounded-full border border-cyan-500/20 bg-cyan-500/[0.05] px-3 py-1 text-xs font-medium text-cyan-900 dark:text-cyan-100"
            >
              {primaryAgentLabel}
            </span>
          ) : null}

          {!simpleMode && enableReassign && reassignOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <InlineEntitySelector
                value={reassignTarget}
                options={reassignOptions}
                placeholder="Agent"
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                onChange={setReassignTarget}
                className="text-xs h-8"
                renderTriggerValue={(option) => {
                  if (!option) return <span className="text-muted-foreground">Agent</span>;
                  const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
                  const agent = agentId ? agentMap?.get(agentId) : null;
                  return (
                    <>
                      {agent ? (
                        <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
                  const agent = agentId ? agentMap?.get(agentId) : null;
                  return (
                    <>
                      {agent ? (
                        <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
              {directedAgentOption ? (
                <span
                  data-testid="issue-directed-routing-chip"
                  className="rounded-full border border-cyan-500/20 bg-cyan-500/[0.04] px-2.5 py-1 text-[11px] text-cyan-900 dark:text-cyan-100"
                >
                  {directedAgentOption.label}
                </span>
              ) : null}
            </div>
          )}

          {!simpleMode ? (
            <>
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger className="h-8 min-w-[150px] text-xs">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  {COMMENT_MODEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={selectedReasoning} onValueChange={setSelectedReasoning}>
                <SelectTrigger className="h-8 min-w-[160px] text-xs">
                  <SelectValue placeholder="Reasoning" />
                </SelectTrigger>
                <SelectContent>
                  {COMMENT_REASONING_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : null}

          <Button data-testid="issue-send-turn" size="xs" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? "Sending..." : "Send Turn"}
          </Button>
        </div>
      </div>
    </section>
  );
}
