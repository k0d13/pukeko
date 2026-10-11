import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { type Session } from "#/agent/index.ts";
import { config, effortLevels } from "#/core/config.ts";
import { usageReport } from "./usage.ts";

export const commands = [
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a fresh conversation here, optionally with another model or effort")
    .addStringOption((o) =>
      o
        .setName("model")
        .setDescription("Opus, Sonnet, Haiku or a full model ID, kept until changed")
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("effort")
        .setDescription("How hard the model thinks, kept until changed")
        .addChoices(
          { name: "default", value: "default" },
          ...effortLevels.map((level) => ({ name: level, value: level })),
        ),
    ),
  new SlashCommandBuilder().setName("stop").setDescription("Stop the current turn here"),
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Summarise this conversation to free up context"),
  new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Plan limits and this conversation's usage"),
];

async function handleNew(interaction: ChatInputCommandInteraction, session: Session) {
  const model = interaction.options.getString("model");
  const effort = interaction.options.getString("effort") as
    | (typeof effortLevels)[number]
    | "default"
    | null;
  // "default" goes back to pukeko.toml, unset keeps the current choice
  session.reset({
    ...(model && { model: model === "default" ? config.agent.model : model }),
    ...(effort && { effort: effort === "default" ? config.agent.effort : effort }),
  });
  const setup = session.setup;
  const details = [setup.model, setup.effort && `${setup.effort} effort`].filter(Boolean);
  return interaction.reply(
    `🆕 Fresh conversation started${details.length ? ` (${details.join(", ")})` : ""}`,
  );
}

// Model aliases Claude Code understands, plus whatever's been typed
const modelChoices = ["default", "opus", "sonnet", "haiku"];

export function autocomplete(interaction: AutocompleteInteraction) {
  const typed = interaction.options.getFocused().trim();
  const choices = modelChoices.filter((name) => name.startsWith(typed.toLowerCase()));
  if (typed && !choices.includes(typed)) choices.push(typed);
  return interaction.respond(choices.map((name) => ({ name, value: name })));
}

export async function handle(interaction: ChatInputCommandInteraction, session: Session) {
  switch (interaction.commandName) {
    case "new":
      return handleNew(interaction, session);
    case "stop":
      return interaction.reply(session.stop() ? "⏹️ Stopping" : "Nothing running");
    case "compact":
      await interaction.deferReply();
      return interaction.editReply(await session.compact());
    case "usage":
      await interaction.deferReply();
      return interaction.editReply(await usageReport(session));
  }
}
