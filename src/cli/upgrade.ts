import { chmod, rename, rm } from "node:fs/promises";
import { $ } from "bun";
import { defineCommand } from "citty";
import { consola } from "consola";
import { compiled, repo, version } from "#/core/release.ts";

export default defineCommand({
  meta: { name: "upgrade", description: "Update to the latest release and restart" },
  async run() {
    if (!compiled) {
      consola.error("Only compiled binaries can upgrade themselves");
      process.exit(1);
    }
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
    if (!response.ok) {
      consola.error(`Couldn't check for releases: ${response.status}`);
      process.exit(1);
    }
    const { tag_name: latest } = (await response.json()) as { tag_name: string };
    if (latest === version) return consola.success(`Already on ${version}`);

    const platform = `${process.platform}-${process.arch}`;
    consola.start(`Downloading ${latest} (${platform}), you're on ${version}`);
    const download = await fetch(
      `https://github.com/${repo}/releases/download/${latest}/pukeko-${platform}`,
    );
    if (!download.ok) {
      consola.error(`No ${platform} build in ${latest}: ${download.status}`);
      process.exit(1);
    }

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
    if (Bun.which("systemctl")) {
      const active = await $`systemctl --user is-active --quiet pukeko`.nothrow();
      if (!active.exitCode) await $`systemctl --user restart pukeko`;
    }
  },
});
