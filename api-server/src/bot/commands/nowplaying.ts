import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getQueue } from "../queue.js";
import { buildEmbed, buildRows } from "../panel.js";

export const data = new SlashCommandBuilder()
  .setName("nowplaying")
  .setDescription("Show what's currently playing");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const queue = getQueue(interaction.guildId!);

  if (!queue || !queue.playing || queue.tracks.length === 0) {
    await interaction.reply({ content: "Nothing is playing right now.", ephemeral: true });
    return;
  }

  // Reset the tracked panel so this reply becomes the new panel message
  if (queue.panelMessage) {
    await queue.panelMessage.edit({ components: [] }).catch(() => {});
    queue.panelMessage = null;
  }

  const embed = buildEmbed(queue);
  const msg = await interaction.reply({
    embeds: [embed],
    components: buildRows(),
    fetchReply: true,
  });
  queue.panelMessage = msg;
}
