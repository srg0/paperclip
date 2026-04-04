import { describe, expect, it } from "vitest";
import { processAdapter } from "../adapters/process/index.js";
import { httpAdapter } from "../adapters/http/index.js";
import { findServerAdapter } from "../adapters/registry.js";

const requiredPaperclipSkill = {
  key: "paperclipai/paperclip/paperclip",
  runtimeName: "paperclip",
  source: "/tmp/skills/paperclip",
  required: true,
  requiredReason: "Bundled Paperclip skills are always available for local adapters.",
} as const;

describe("config-driven skill sync", () => {
  it("process adapter reports configured skills without adapter-specific sync implementation", async () => {
    const snapshot = await processAdapter.listSkills?.({
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "process",
      config: {
        paperclipRuntimeSkills: [requiredPaperclipSkill],
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    });

    expect(snapshot).toBeTruthy();
    expect(snapshot?.supported).toBe(true);
    expect(snapshot?.mode).toBe("ephemeral");
    expect(snapshot?.desiredSkills).toEqual(["paperclipai/paperclip/paperclip"]);
    expect(snapshot?.warnings).toEqual([]);
    expect(snapshot?.entries.find((entry) => entry.key === requiredPaperclipSkill.key)?.state).toBe("configured");
  });

  it("http adapter reports missing desired skill with a warning", async () => {
    const snapshot = await httpAdapter.syncSkills?.({
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "http",
      config: {
        paperclipRuntimeSkills: [requiredPaperclipSkill],
        paperclipSkillSync: {
          desiredSkills: ["non-existent-skill"],
        },
      },
    }, ["non-existent-skill"]);

    expect(snapshot).toBeTruthy();
    expect(snapshot?.supported).toBe(true);
    expect(snapshot?.warnings.some((warning) => warning.includes("non-existent-skill"))).toBe(true);
    expect(snapshot?.entries.find((entry) => entry.key === "non-existent-skill")?.state).toBe("missing");
  });

  it("openclaw gateway adapter exposes config-driven skill sync handlers", async () => {
    const adapter = findServerAdapter("openclaw_gateway");
    expect(adapter?.listSkills).toBeTypeOf("function");
    expect(adapter?.syncSkills).toBeTypeOf("function");

    const snapshot = await adapter?.listSkills?.({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "openclaw_gateway",
      config: {
        paperclipRuntimeSkills: [requiredPaperclipSkill],
        paperclipSkillSync: {
          desiredSkills: [requiredPaperclipSkill.key],
        },
      },
    });

    expect(snapshot?.supported).toBe(true);
    expect(snapshot?.entries.find((entry) => entry.key === requiredPaperclipSkill.key)?.state).toBe("configured");
  });
});

