import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getQueue } from "../queue.js";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop playing and clear the queue (bot stays in channel — use /leave to disconnect)");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const queue = getQueue(guildId);

  if (!queue) {
    await interaction.reply("Nothing is playing right now.");
    return;
  }

  // Disable buttons on the panel message
  if (queue.panelMessage) {
    await queue.panelMessage.edit({ components: [] }).catch(() => {});
    queue.panelMessage = null;
  }

  queue.tracks = [];
  queue.player.stop(true);
  queue.playing = false;
  queue.paused = false;

  await interaction.reply("⏹️ Stopped playback and cleared the queue. I'm still in the channel — use `/leave` to disconnect.");
}
