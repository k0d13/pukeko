import { userInfo } from "node:os";
import { $ } from "bun";
import { defineCommand } from "citty";
import { consola } from "consola";
import { paths } from "#/core/paths.ts";
import { compiled } from "#/core/release.ts";
import unit from "./pukeko.service" with { type: "text" };

export default defineCommand({
  meta: { name: "service", description: "Run Pukeko as a systemd user service, now and on boot" },
  async run() {
    if (!Bun.which("systemctl")) {
      consola.error("No systemctl here, run `pukeko` some other way");
      process.exit(1);
    }
    // From source the unit would run Bun itself, without the script
    if (!compiled) {
      consola.error("Only a compiled binary can run as a service, `bun run build` first");
      process.exit(1);
    }
    await Bun.write(
      paths.unit,
      unit
        .replace("{exec}", process.execPath)
        .replace("{workspace}", paths.workspace)
        .replace("{path}", process.env.PATH ?? ""),
    );
    consola.info(`Wrote ${paths.unit}`);
    await $`systemctl --user daemon-reload`;
    await $`systemctl --user enable pukeko`;
    await $`systemctl --user restart pukeko`;

    // Without lingering, user services stop at logout
    const { username } = userInfo();
    const linger = await $`loginctl show-user ${username} --property=Linger`.nothrow().text();
    if (!linger.includes("Linger=yes")) await $`sudo loginctl enable-linger ${username}`;
    consola.success("Pukeko is running, `pukeko logs` to follow along");
  },
});
