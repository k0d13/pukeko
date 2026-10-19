import { Events, type Interaction } from "discord.js";
import { config, secrets } from "#/core/config.ts";
import { handleMessage } from "./ask.ts";
import { loadButtons } from "./buttons.ts";
import { handleComponent } from "./clicks.ts";
import { client, owner, tell } from "./client.ts";
import { runCommand } from "./commands.ts";

function handleInteraction(interaction: Interaction) {
  const component = interaction.isMessageComponent() || interaction.isModalSubmit();
  if (!component || !interaction.customId.startsWith("pk:")) return runCommand(interaction);
  if (interaction.user.id !== owner.id) return tell(interaction, "Not yours 🐦");
  return handleComponent(interaction);
}

client.on(Events.MessageCreate, (message) => {
  handleMessage(message).catch(console.error);
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch(console.error);
});

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
  console.log(`Logged in as ${client.user!.tag}, answering to ${owner.id}`);
}
