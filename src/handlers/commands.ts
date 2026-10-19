import { report } from "#/core/log.ts";
import { type Command, commands, registerCommands } from "#/discord/commands.ts";

type Module = Record<string, unknown>;

function handler(module: Module, key: string) {
  const value = module[key];
  if (value !== undefined && typeof value !== "function")
    throw new Error(`\`${key}\` should be a function`);
  return value as Command["run"] | undefined;
}

// commands/<id>.ts: `data` (a builder or command JSON), `run`, and optionally the rest of Command
export function addCommand(id: string, module: Module) {
  const raw = module.data as { toJSON?: () => Command["data"] } | undefined;
  const data = (typeof raw?.toJSON === "function" ? raw.toJSON() : raw) as
    | Command["data"]
    | undefined;
  if (!data?.name)
    throw new Error("Needs `export const data`, a SlashCommandBuilder or command JSON");
  const run = handler(module, "run");
  if (!run) throw new Error("Needs `export async function run(interaction)`");
  const file = `commands/${id}`;
  const other = commands.get(data.name);
  if (other && other.file !== file)
    throw new Error(`/${data.name} is already ${other.file ?? "one of Pukeko's own commands"}`);
  removeCommand(id);
  commands.set(data.name, {
    data,
    run,
    autocomplete: handler(module, "autocomplete"),
    component: handler(module, "component"),
    everyone: module.everyone === true,
    file,
  });
}

export function removeCommand(id: string) {
  for (const [name, command] of commands)
    if (command.file === `commands/${id}`) commands.delete(name);
}

export async function syncCommands() {
  try {
    await registerCommands();
  } catch (error) {
    // Discord takes all or nothing, so the last set that worked stays registered
    report("Discord rejected the commands, the previous set stays registered", error);
  }
}
