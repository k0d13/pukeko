import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "logs", description: "Follow the service's logs" },
  // Not Bun's $, which would keep every line in memory
  run: () =>
    Bun.spawn(["journalctl", "--user", "-u", "pukeko", "-f"], {
      stdio: ["inherit", "inherit", "inherit"],
    }).exited,
});
