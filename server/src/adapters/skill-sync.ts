import type { AdapterSkillContext, AdapterSkillEntry, AdapterSkillSnapshot } from "./types.js";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

interface ConfigDrivenSkillSyncOptions {
  adapterType: string;
  moduleDir: string;
  configuredDetail?: string;
  missingDetail?: string;
}

async function buildConfigDrivenSkillSnapshot(
  config: Record<string, unknown>,
  options: ConfigDrivenSkillSyncOptions,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, options.moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);

  const configuredDetail = options.configuredDetail
    ?? "Skill is configured via Paperclip and will be available on the next run.";
  const missingDetail = options.missingDetail
    ?? "Paperclip cannot find this skill in the configured runtime skill catalog.";

  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key) ? configuredDetail : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));
  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: missingDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: options.adapterType,
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export function createConfigDrivenSkillHandlers(options: ConfigDrivenSkillSyncOptions) {
  return {
    listSkills: async (ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> =>
      buildConfigDrivenSkillSnapshot(ctx.config, options),
    syncSkills: async (ctx: AdapterSkillContext, _desiredSkills: string[]): Promise<AdapterSkillSnapshot> =>
      buildConfigDrivenSkillSnapshot(ctx.config, options),
  };
}

