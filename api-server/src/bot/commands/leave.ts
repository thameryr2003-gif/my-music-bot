import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { destroyQueue, getQueue } from "../queue.js";

export const data = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("Stop playback and disconnect from the voice channel");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const queue = getQueue(guildId);

  destroyQueue(guildId);

  if (queue) {
    await interaction.reply("👋 Stopped playback, cleared the queue, and left the voice channel.");
  } else {
    await interaction.reply("I'm not currently in a voice channel.");
  }
}
