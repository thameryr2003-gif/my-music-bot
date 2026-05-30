import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getQueue } from "../queue.js";
import { AudioPlayerStatus } from "@discordjs/voice";

export const data = new SlashCommandBuilder()
  .setName("pause")
  .setDescription("Pause or resume the current song");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const queue = getQueue(interaction.guildId!);

  if (!queue || !queue.playing) {
    await interaction.reply("Nothing is playing right now.");
    return;
  }

  if (queue.paused) {
    queue.player.unpause();
    queue.paused = false;
    await interaction.reply("Resumed playback.");
  } else {
    queue.player.pause();
    queue.paused = true;
    await interaction.reply("Paused playback.");
  }
}
