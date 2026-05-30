import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { getQueue } from "../queue.js";

export const data = new SlashCommandBuilder()
  .setName("queue")
  .setDescription("Show the current song queue");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const queue = getQueue(interaction.guildId!);

  if (!queue || queue.tracks.length === 0) {
    await interaction.reply("The queue is empty.");
    return;
  }

  const lines = queue.tracks.map((t, i) => {
    const prefix = i === 0 ? "**Now playing:**" : `**#${i}.**`;
    return `${prefix} ${t.title} — *${t.requestedBy}*`;
  });

  const embed = new EmbedBuilder()
    .setTitle("Song Queue")
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({ text: `${queue.tracks.length} track(s) in queue` });

  await interaction.reply({ embeds: [embed] });
}
