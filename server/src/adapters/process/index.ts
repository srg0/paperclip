import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConfigDrivenSkillHandlers } from "../skill-sync.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const { listSkills, syncSkills } = createConfigDrivenSkillHandlers({
  adapterType: "process",
  moduleDir: __moduleDir,
  configuredDetail: "Skill is configured for this process worker and will be available on the next run.",
});

export const processAdapter: ServerAdapterModule = {
  type: "process",
  execute,
  testEnvironment,
  listSkills,
  syncSkills,
  models: [],
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
