import { chmod, rename, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { consola } from "consola";
import { compiled, repo, version } from "#/core/release.ts";
import { fail } from "./fail.ts";
import { isRunning, restartAfterTurn, systemctl } from "./service.ts";

export default defineCommand({
  meta: { name: "upgrade", description: "Update to the latest release and restart" },
  args: {
    check: { type: "boolean", description: "Only say whether there's a newer release" },
    "after-turn": {
      type: "boolean",
      description: "Restart once running turns and their replies are done, not straight away",
    },
  },
  async run({ args }) {
    if (!compiled && !args.check) fail("Only compiled binaries can upgrade themselves");
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
    if (!response.ok) fail(`Couldn't check for releases: ${response.status}`);
    const { tag_name: latest } = (await response.json()) as { tag_name: string };
    if (latest === version) return consola.success(`Already on ${version}`);
    if (args.check) return consola.info(`${latest} is out, you're on ${version}`);

    const platform = `${process.platform}-${process.arch}`;
    consola.start(`Downloading ${latest} (${platform}), you're on ${version}`);
    const download = await fetch(
      `https://github.com/${repo}/releases/download/${latest}/pukeko-${platform}`,
    );
    if (!download.ok) fail(`No ${platform} build in ${latest}: ${download.status}`);

    // Renamed over the old one, so a failed download never leaves a broken binary
    const temporary = `${process.execPath}.new`;
    try {
      await Bun.write(temporary, download);
      await chmod(temporary, 0o755);
      await rename(temporary, process.execPath);
    } finally {
      await rm(temporary, { force: true });
    }
    consola.success(`Upgraded to ${latest}`);
    if (!(await isRunning())) return;
    if (args["after-turn"]) return restartAfterTurn();
    await systemctl("restart", "pukeko");
  },
});
