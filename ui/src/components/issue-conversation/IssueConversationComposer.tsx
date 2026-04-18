import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { AtSign, GitPullRequestArrow, Paperclip, RotateCcw, Square } from "lucide-react";
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
}

interface SlashCommandDefinition {
  id: SlashCommandId | "reopen" | "mention" | "attach";
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
    id: "reopen",
    label: "Re-open Issue",
    command: "/reopen",
    description: "Keeps the issue reopened when you send the next turn.",
    group: "Composer Controls",
  },
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
}: IssueConversationComposerProps) {
  const [body, setBody] = useState("");
  const [reopen, setReopen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  const slashQuery = resolveSlashQuery(body);
  const slashOptions = slashQuery === null
    ? []
    : [...TASK_SLASH_COMMANDS, ...((imageUploadHandler || onAttachImage || mentions.length > 0 || enableReassign) ? COMPOSER_SLASH_COMMANDS : [])]
        .filter((command) => {
          const haystack = `${command.command} ${command.label} ${command.description}`.toLowerCase();
          return haystack.includes(slashQuery);
        });

  async function applyComposerCommand(commandId: "reopen" | "mention" | "attach") {
    if (commandId === "reopen") {
      setReopen(true);
      setBody("");
      editorRef.current?.focus();
      return;
    }
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
    const directedAgentTargetId =
      enableReassign && reassignTarget.startsWith("agent:") ? reassignTarget.slice("agent:".length) : null;

    setSubmitting(true);
    try {
      if (commandId === "mr") {
        await onAdd("сделай mr", reopen ? true : undefined, reassignment ?? undefined, directedAgentTargetId);
      } else if (commandId === "cancel") {
        await onAdd("Останови текущий запуск и продолжи с новым turn.", reopen ? true : undefined, reassignment ?? undefined, directedAgentTargetId, {
          interrupt: true,
        });
      }
      setBody("");
      setReopen(true);
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
    if (trimmed === "/mr") {
      await submitSlashCommand("mr");
      return;
    }
    if (trimmed === "/cancel") {
      await submitSlashCommand("cancel");
      return;
    }
    if (trimmed === "/reopen") {
      await applyComposerCommand("reopen");
      return;
    }
    if (trimmed === "/mention") {
      await applyComposerCommand("mention");
      return;
    }
    if (trimmed === "/attach") {
      await applyComposerCommand("attach");
      return;
    }

    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : null;
    const directedAgentTargetId =
      enableReassign && reassignTarget.startsWith("agent:") ? reassignTarget.slice("agent:".length) : null;

    setSubmitting(true);
    try {
      await onAdd(
        trimmed,
        reopen ? true : undefined,
        reassignment ?? undefined,
        directedAgentTargetId,
      );
      setBody("");
      setReopen(true);
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
    <section className="codex-issue-surface rounded-2xl border border-border/70 bg-background/90 p-3.5 shadow-[var(--codex-surface-shadow)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
            Continue Task
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            Send the next turn without dropping back into raw issue comments.
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <MarkdownEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          placeholder="Tell the task what should happen next... Use / for commands."
          mentions={mentions}
          onSubmit={handleSubmit}
          imageUploadHandler={imageUploadHandler}
          contentClassName="min-h-[96px] text-sm"
        />

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
                          ) : command.id === "reopen" ? (
                            <RotateCcw className="mt-0.5 h-4 w-4" />
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

        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {["/mr", "/cancel", "/reopen", "/mention"].map((command) => (
            <button
              key={command}
              type="button"
              className="rounded-full border border-border/70 bg-background/60 px-2.5 py-1 transition-colors hover:bg-accent/30"
              onClick={() => setBody(command)}
            >
              {command}
            </button>
          ))}
          {(imageUploadHandler || onAttachImage) ? (
            <button
              type="button"
              className="rounded-full border border-border/70 bg-background/60 px-2.5 py-1 transition-colors hover:bg-accent/30"
              onClick={() => setBody("/attach")}
            >
              /attach
            </button>
          ) : null}
        </div>

        {directedAgentOption ? (
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2 text-[11px] text-cyan-900 dark:text-cyan-100">
            This turn will be routed directly to <span className="font-medium">{directedAgentOption.label}</span> using the full task context.
          </div>
        ) : null}

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

          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={reopen}
              onChange={(e) => setReopen(e.target.checked)}
              className="rounded border-border"
            />
            Re-open
          </label>

          {enableReassign && reassignOptions.length > 0 && (
            <InlineEntitySelector
              value={reassignTarget}
              options={reassignOptions}
              placeholder="Assignee"
              noneLabel="No assignee"
              searchPlaceholder="Search assignees..."
              emptyMessage="No assignees found."
              onChange={setReassignTarget}
              className="text-xs h-8"
              renderTriggerValue={(option) => {
                if (!option) return <span className="text-muted-foreground">Assignee</span>;
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
          )}

          <Button size="xs" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting ? "Sending..." : "Send Turn"}
          </Button>
        </div>
      </div>
    </section>
  );
}
