import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { channelSession } from "#/agent/index.ts";
import { config, effortLevels } from "#/core/config.ts";
import type { Command } from "./commands.ts";
import { usageReport } from "./usage.ts";

function session(interaction: ChatInputCommandInteraction) {
  return channelSession(interaction.channelId);
}

async function handleNew(interaction: ChatInputCommandInteraction) {
  const model = interaction.options.getString("model");
  const effort = interaction.options.getString("effort") as EffortLevel | "default" | null;
  const current = await session(interaction);
  // "default" goes back to pukeko.toml, unset keeps the current choice
  current.reset({
    ...(model && { model: model === "default" ? config.agent.model : model }),
    ...(effort && { effort: effort === "default" ? config.agent.effort : effort }),
  });
  const setup = current.setup;
  const details = [setup.model, setup.effort && `${setup.effort} effort`].filter(Boolean);
  return interaction.reply(
    `🆕 Fresh conversation started${details.length ? ` (${details.join(", ")})` : ""}`,
  );
}

// Model aliases Claude Code understands, plus whatever's been typed
const modelChoices = ["default", "opus", "sonnet", "haiku"];

function autocomplete(interaction: AutocompleteInteraction) {
  const typed = interaction.options.getFocused().trim();
  const choices = modelChoices.filter((name) => name.startsWith(typed.toLowerCase()));
  if (typed && !choices.includes(typed)) choices.push(typed);
  return interaction.respond(choices.map((name) => ({ name, value: name })));
}

export const commands: Command[] = [
  {
    data: new SlashCommandBuilder()
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
      )
      .toJSON(),
    run: handleNew,
    autocomplete,
  },
  {
    data: new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Stop the current turn here")
      .toJSON(),
    run: async (interaction: ChatInputCommandInteraction) =>
      interaction.reply((await session(interaction)).stop() ? "⏹️ Stopping" : "Nothing running"),
  },
  {
    data: new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Summarise this conversation to free up context")
      .toJSON(),
    async run(interaction: ChatInputCommandInteraction) {
      await interaction.deferReply();
      await interaction.editReply(await (await session(interaction)).compact());
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName("usage")
      .setDescription("Plan limits and this conversation's usage")
      .toJSON(),
    async run(interaction: ChatInputCommandInteraction) {
      await interaction.deferReply();
      await interaction.editReply(await usageReport(await session(interaction)));
    },
  },
];
