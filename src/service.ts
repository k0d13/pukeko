import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import unit from "./pukeko.service" with { type: "text" };

// A systemd user unit that runs this binary on this workspace
export function installService(workspace: string) {
  const unitPath = join(homedir(), ".config/systemd/user/pukeko.service");
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(
    unitPath,
    unit
      .replace("{exec}", process.execPath)
      .replace("{workspace}", workspace)
      .replace("{path}", process.env.PATH ?? ""),
  );
  console.log(`Wrote ${unitPath}. Now run:`);
  console.log("  systemctl --user daemon-reload && systemctl --user enable --now pukeko");
  console.log("  sudo loginctl enable-linger $USER   # keep running while logged out");
  console.log("  journalctl --user -u pukeko -f      # logs");
}
