import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getQueue, playNext } from "../queue.js";

export const data = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("Skip the current song");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const queue = getQueue(guildId);

  if (!queue || !queue.playing) {
    await interaction.reply("Nothing is playing right now.");
    return;
  }

  queue.tracks.shift();
  queue.player.stop();

  if (queue.tracks.length === 0) {
    await interaction.reply("Skipped. The queue is now empty.");
  } else {
    await interaction.reply(`Skipped! Up next: **${queue.tracks[0]!.title}**`);
    await playNext(guildId);
  }
}
