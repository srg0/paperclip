import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConfigDrivenSkillHandlers } from "../skill-sync.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const { listSkills, syncSkills } = createConfigDrivenSkillHandlers({
  adapterType: "http",
  moduleDir: __moduleDir,
  configuredDetail: "Skill is configured for this HTTP worker and will be available on the next run.",
});

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  execute,
  testEnvironment,
  listSkills,
  syncSkills,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds
`,
};
