import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import env from "../../templates/.env.example" with { type: "text" };
import gitignore from "../../templates/.gitignore" with { type: "text" };
import memoryIndex from "../../templates/memory/README.md" with { type: "text" };
import pukekoToml from "../../templates/pukeko.toml" with { type: "text" };

// The bare minimum the harness needs, embedded in the binary and written on
// first run. Personality (CLAUDE.md), integrations (.mcp.json) and jobs are
// the owner's to add
const templates = {
  ".env": env,
  ".gitignore": gitignore,
  "memory/README.md": memoryIndex,
  "pukeko.toml": pukekoToml,
};

// Writes any missing starter files; never overwrites
export function createWorkspace(workspace: string) {
  for (const [path, content] of Object.entries(templates)) {
    const target = join(workspace, path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`Created ${target}`);
  }
  console.log(`Workspace ready at ${workspace}`);
}
