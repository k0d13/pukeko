import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Filled by `setWorkspace` before any command runs */
export const paths = {
  workspace: "",
  toml: "",
  env: "",
  mcp: "",
  jobs: "",
  triggers: "",
  commands: "",
  /** What jobs, triggers and commands did on loading and failing, for the agent to read */
  log: "",
  /** Saved conversations, which the agent is denied */
  state: "",
  unit: join(homedir(), ".config/systemd/user/pukeko.service"),
};

export function setWorkspace(flag?: string) {
  const workspace = resolve(
    flag || process.env.PUKEKO_WORKSPACE || join(homedir(), ".pukeko", "workspace"),
  );
  Object.assign(paths, {
    workspace,
    toml: join(workspace, "pukeko.toml"),
    env: join(workspace, ".env"),
    mcp: join(workspace, ".mcp.json"),
    jobs: join(workspace, "jobs"),
    triggers: join(workspace, "triggers"),
    commands: join(workspace, "commands"),
    log: join(workspace, "logs", "pukeko.log"),
    state: join(workspace, ".pukeko"),
  });
}
