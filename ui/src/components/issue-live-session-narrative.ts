import type { TranscriptEntry } from "../adapters";
import { normalizeTranscript } from "./transcript/RunTranscriptView";

export type NarrativeTone = "info" | "working" | "success" | "warn" | "error";

export interface NarrativeStep {
  ts: string;
  title: string;
  detail: string;
  tone: NarrativeTone;
}

export interface NarrativeSummary {
  current: NarrativeStep | null;
  timeline: NarrativeStep[];
  statusLine: string;
}

type TranscriptBlock = ReturnType<typeof normalizeTranscript>[number];

const TOOL_LABEL_OVERRIDES: Record<string, string> = {
  command_execution: "Shell command",
  shell: "Shell command",
  bash: "Shell command",
  read_file: "Read file",
  write_file: "Write file",
  search_files: "Search files",
  grep: "Search files",
  list_files: "List files",
  open: "Open page",
  click: "Click page action",
  find: "Find page content",
  finance: "Check finance data",
  weather: "Check weather",
  sports: "Check sports data",
};

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function toSentence(value: string): string {
  const compact = compactWhitespace(value);
  if (!compact) return "";
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeToolName(value: string): string {
  const override = TOOL_LABEL_OVERRIDES[value];
  if (override) return override;
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function summarizeInput(value: unknown): string {
  if (typeof value === "string") return truncate(compactWhitespace(value));
  const record = asRecord(value);
  if (!record) return truncate(compactWhitespace(formatUnknown(value)));

  const directKeys = ["command", "cmd", "path", "filePath", "file_path", "query", "url", "prompt", "message"];
  for (const key of directKeys) {
    const candidate = record[key];
    if (typeof candidate === "string" && compactWhitespace(candidate)) {
      return truncate(compactWhitespace(candidate));
    }
  }

  if (Array.isArray(record["paths"])) {
    const firstPath = record["paths"].find((entry): entry is string => typeof entry === "string" && compactWhitespace(entry).length > 0);
    if (firstPath) {
      return truncate(`Inspecting ${record["paths"].length} paths, starting with ${firstPath}`);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return "";
  return truncate(`Payload fields: ${keys.slice(0, 3).join(", ")}`);
}

function summarizeResult(value?: string): string {
  if (!value) return "";
  return truncate(compactWhitespace(value));
}

function describeToolBlock(block: Extract<TranscriptBlock, { type: "tool" }>): NarrativeStep {
  const toolLabel = humanizeToolName(block.name);
  const detail = summarizeResult(block.result) || summarizeInput(block.input);

  if (block.status === "running") {
    return {
      ts: block.ts,
      title: `${toolLabel} in progress`,
      detail: detail || "The agent is waiting for this tool call to finish.",
      tone: "working",
    };
  }

  if (block.status === "error") {
    return {
      ts: block.endTs ?? block.ts,
      title: `${toolLabel} failed`,
      detail: detail || "The tool returned an error.",
      tone: "error",
    };
  }

  return {
    ts: block.endTs ?? block.ts,
    title: `${toolLabel} completed`,
    detail: detail || "The tool call finished successfully.",
    tone: "info",
  };
}

function describeCommandGroup(block: Extract<TranscriptBlock, { type: "command_group" }>): NarrativeStep {
  const lastItem = block.items[block.items.length - 1];
  const hasError = block.items.some((item) => item.isError);
  const isRunning = block.items.some((item) => item.status === "running");
  const detail = summarizeResult(lastItem?.result) || summarizeInput(lastItem?.input);

  if (hasError) {
    return {
      ts: block.endTs ?? block.ts,
      title: "Shell command failed",
      detail: detail || "The latest command returned an error.",
      tone: "error",
    };
  }

  if (isRunning) {
    return {
      ts: block.endTs ?? block.ts,
      title: "Shell command running",
      detail: detail || "The agent is still collecting command output.",
      tone: "working",
    };
  }

  return {
    ts: block.endTs ?? block.ts,
    title: block.items.length > 1 ? "Command batch completed" : "Shell command completed",
    detail: detail || "Command output was captured.",
    tone: "info",
  };
}

function describeToolGroup(block: Extract<TranscriptBlock, { type: "tool_group" }>): NarrativeStep {
  const lastItem = block.items[block.items.length - 1];
  const hasError = block.items.some((item) => item.isError);
  const isRunning = block.items.some((item) => item.status === "running");
  const detail = summarizeResult(lastItem?.result) || summarizeInput(lastItem?.input);

  if (hasError) {
    return {
      ts: block.endTs ?? block.ts,
      title: "Tool chain hit an error",
      detail: detail || "One of the tool calls failed.",
      tone: "error",
    };
  }

  if (isRunning) {
    return {
      ts: block.endTs ?? block.ts,
      title: "Tool chain in progress",
      detail: detail || `Working through ${block.items.length} tool calls.`,
      tone: "working",
    };
  }

  return {
    ts: block.endTs ?? block.ts,
    title: block.items.length > 1 ? "Tool chain completed" : `${humanizeToolName(lastItem?.name ?? "Tool")} completed`,
    detail: detail || "The tools finished successfully.",
    tone: "info",
  };
}

function describeBlock(block: TranscriptBlock): NarrativeStep | null {
  switch (block.type) {
    case "message":
      return {
        ts: block.ts,
        title: block.role === "assistant"
          ? block.streaming
            ? "Agent is writing an update"
            : "Agent update"
          : "User feedback received",
        detail: truncate(compactWhitespace(block.text)),
        tone: block.role === "assistant" ? "info" : "working",
      };
    case "thinking":
      return {
        ts: block.ts,
        title: block.streaming ? "Agent is planning the next move" : "Agent mapped the next steps",
        detail: truncate(compactWhitespace(block.text)),
        tone: "working",
      };
    case "tool":
      return describeToolBlock(block);
    case "command_group":
      return describeCommandGroup(block);
    case "tool_group":
      return describeToolGroup(block);
    case "stderr_group": {
      const lastLine = block.lines[block.lines.length - 1];
      return {
        ts: block.endTs ?? block.ts,
        title: "Error output received",
        detail: truncate(compactWhitespace(lastLine?.text ?? "The run emitted stderr output.")),
        tone: "error",
      };
    }
    case "activity":
      return {
        ts: block.ts,
        title: block.status === "running" ? `${toSentence(block.name)} in progress` : `${toSentence(block.name)} completed`,
        detail: block.status === "running" ? "Background activity is still running." : "Background activity finished.",
        tone: block.status === "running" ? "working" : "info",
      };
    case "event":
      return {
        ts: block.ts,
        title: block.label === "result"
          ? block.tone === "error"
            ? "Run finished with an error"
            : "Result is ready"
          : block.label === "init"
            ? "Session started"
            : toSentence(block.label),
        detail: truncate(compactWhitespace(block.detail ?? block.text)),
        tone:
          block.tone === "error"
            ? "error"
            : block.label === "result"
              ? "success"
              : block.tone === "warn"
                ? "warn"
                : "info",
      };
    case "stdout":
      return null;
    default:
      return null;
  }
}

function dedupeSteps(steps: NarrativeStep[]): NarrativeStep[] {
  const deduped: NarrativeStep[] = [];
  for (const step of steps) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.title === step.title && previous.detail === step.detail && previous.tone === step.tone) {
      deduped[deduped.length - 1] = step;
      continue;
    }
    deduped.push(step);
  }
  return deduped;
}

export function buildNarrativeSummary(entries: TranscriptEntry[], streaming: boolean): NarrativeSummary {
  const blocks = normalizeTranscript(entries, streaming);
  const steps = dedupeSteps(blocks.map((block) => describeBlock(block)).filter((step): step is NarrativeStep => step !== null));
  const timeline = steps.slice(-5);
  const current = timeline[timeline.length - 1] ?? null;

  if (!current) {
    return {
      current: null,
      timeline: [],
      statusLine: streaming
        ? "The session is live. Waiting for the first readable signal."
        : "No readable transcript was captured for this run yet.",
    };
  }

  return {
    current,
    timeline,
    statusLine:
      current.tone === "error"
        ? "The latest visible step needs attention before the run can settle."
        : current.tone === "success"
          ? "The run has produced a result that is ready for review."
          : streaming
            ? "The session is still live. Comment below to redirect or clarify the task."
            : "The latest visible checkpoint is captured below for quick review.",
  };
}
