import { rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { $ } from "bun";
import { defineCommand } from "citty";
import { consola } from "consola";
import { paths } from "#/core/paths.ts";
import { compiled } from "#/core/release.ts";
import { fail } from "./fail.ts";
import unit from "./pukeko.service" with { type: "text" };

/** Runs `systemctl --user` in the terminal, returning its exit code */
export function systemctl(...args: string[]) {
  if (!Bun.which("systemctl")) fail("No systemctl here, run `pukeko` some other way");
  return Bun.spawn(["systemctl", "--user", ...args], { stdio: ["inherit", "inherit", "inherit"] })
    .exited;
}

export async function isRunning() {
  return (
    Boolean(Bun.which("systemctl")) &&
    !(await $`systemctl --user is-active --quiet pukeko`.nothrow()).exitCode
  );
}

/**
 * Asks the running service to restart once its turns have finished and their replies are posted, so
 * an agent running inside it can restart Pukeko without being cut off
 */
export async function restartAfterTurn() {
  const pid = Number(
    await $`systemctl --user show pukeko --property=MainPID --value`.nothrow().text(),
  );
  if (!pid) fail("The service isn't running, so there's no turn to wait for");
  process.kill(pid, "SIGUSR2");
  consola.success("Will restart after this reply");
}

async function installed() {
  if (!(await Bun.file(paths.unit).exists())) fail("Not installed, `pukeko service install` first");
}

// A systemctl action on an installed service, exiting with its code
function action(name: string, description: string, done?: string) {
  return defineCommand({
    meta: { name, description },
    async run() {
      await installed();
      if (await systemctl(name, "pukeko")) process.exit(1);
      if (done) consola.success(done);
    },
  });
}

const restart = defineCommand({
  meta: { name: "restart", description: "Restart the service" },
  args: {
    "after-turn": {
      type: "boolean",
      description: "Restart once running turns and their replies are done, not straight away",
    },
  },
  async run({ args }) {
    await installed();
    if (args["after-turn"]) return restartAfterTurn();
    if (await systemctl("restart", "pukeko")) process.exit(1);
    consola.success("Restarted");
  },
});

const install = defineCommand({
  meta: { name: "install", description: "Run Pukeko as a systemd user service, now and on boot" },
  async run() {
    // From source the unit would run Bun itself, without the script
    if (!compiled) fail("Only a compiled binary can run as a service, `bun run build` first");
    await Bun.write(
      paths.unit,
      unit
        .replace("{exec}", process.execPath)
        .replace("{workspace}", paths.workspace)
        .replace("{path}", process.env.PATH ?? ""),
    );
    consola.info(`Wrote ${paths.unit}`);
    await systemctl("daemon-reload");
    await systemctl("enable", "pukeko");
    await systemctl("restart", "pukeko");

    // Without lingering, user services stop at logout
    const { username } = userInfo();
    const linger = await $`loginctl show-user ${username} --property=Linger`.nothrow().text();
    if (!linger.includes("Linger=yes")) await $`sudo loginctl enable-linger ${username}`;
    consola.success("Pukeko is running, `pukeko service logs` to follow along");
  },
});

const uninstall = defineCommand({
  meta: { name: "uninstall", description: "Stop the service and remove it, keeping the workspace" },
  async run() {
    await installed();
    await systemctl("disable", "--now", "pukeko");
    await rm(paths.unit);
    await systemctl("daemon-reload");
    consola.success(`Removed ${paths.unit}`);
  },
});

const logs = defineCommand({
  meta: { name: "logs", description: "Show the service's logs, following along" },
  args: {
    lines: { type: "string", alias: "n", default: "50", description: "How many past lines" },
    follow: {
      type: "boolean",
      default: true,
      description: "Keep printing new lines",
      negativeDescription: "Print and exit",
    },
  },
  // Not Bun's $, which would keep every line in memory
  run: ({ args }) =>
    Bun.spawn(
      ["journalctl", "--user", "-u", "pukeko", "-n", args.lines, ...(args.follow ? ["-f"] : [])],
      { stdio: ["inherit", "inherit", "inherit"] },
    ).exited,
});

export default defineCommand({
  meta: { name: "service", description: "Install and control the systemd user service" },
  default: "status",
  subCommands: {
    install,
    uninstall,
    start: action("start", "Start the service", "Started"),
    stop: action("stop", "Stop the service until started or the server reboots", "Stopped"),
    restart,
    // Exits 3 when stopped, which is an answer rather than a failure
    status: defineCommand({
      meta: { name: "status", description: "Whether it's running, and its latest logs" },
      async run() {
        await installed();
        await systemctl("status", "pukeko", "--no-pager");
      },
    }),
    logs,
  },
});
