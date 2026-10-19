import { Events, type Interaction } from "discord.js";
import { config, secrets } from "#/core/config.ts";
import { logger } from "#/core/log.ts";
import { handleMessage } from "./ask.ts";
import { loadButtons } from "./buttons.ts";
import { handleComponent } from "./clicks.ts";
import { client, owner, tell } from "./client.ts";
import { runCommand } from "./commands.ts";

const log = logger("discord");

function handleInteraction(interaction: Interaction) {
  const component = interaction.isMessageComponent() || interaction.isModalSubmit();
  if (!component || !interaction.customId.startsWith("pk:")) return runCommand(interaction);
  if (interaction.user.id !== owner.id) {
    log.info(`Turned away ${interaction.user.username} from a button, not the owner`);
    return tell(interaction, "Not yours 🐦");
  }
  return handleComponent(interaction);
}

client.on(Events.MessageCreate, (message) => {
  handleMessage(message).catch((error) => log.error("Couldn't answer a message", error));
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch((error) =>
    log.error("Couldn't handle an interaction", error),
  );
});
client.on(Events.ShardDisconnect, (event) =>
  log.warn(`Disconnected (${event.code}), reconnecting`),
);
client.on(Events.ShardResume, () => log.info("Reconnected"));
client.on(Events.Warn, (warning) => log.warn(warning));
client.on(Events.Error, (error) => log.error("Client error", error));

export async function startDiscord() {
  await loadButtons();
  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(secrets.DISCORD_TOKEN);
  await ready;
  const application = await client.application!.fetch();
  // A team-owned application reports the team, whose owner is the one we want
  const appOwner = application.owner;
  owner.id =
    config.owner || ((appOwner && "ownerId" in appOwner ? appOwner.ownerId : appOwner?.id) ?? "");
  if (!owner.id) throw new Error("Couldn't find the application's owner, set owner in pukeko.toml");
  const ownerName = (await client.users.fetch(owner.id).catch(() => undefined))?.username;
  log.info(
    `Logged in as ${client.user!.tag}, in ${client.guilds.cache.size} servers, answering to ${ownerName ?? "?"} (${owner.id}${config.owner ? ", from pukeko.toml" : ", the application owner"})`,
  );
}
