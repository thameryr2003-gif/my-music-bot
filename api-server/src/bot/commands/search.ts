import {
  ChatInputCommandInteraction,
  GuildMember,
  GuildTextBasedChannel,
  SlashCommandBuilder,
} from "discord.js";
import { searchVideo } from "../ytdlp.js";
import { createQueue, getQueue, playNext } from "../queue.js";
import { joinChannel, preferredChannelId } from "../voice.js";
import { sendOrUpdatePanel } from "../panel.js";
import { logger } from "../../lib/logger.js";

export const data = new SlashCommandBuilder()
  .setName("search")
  .setDescription("Search YouTube and play the top result")
  .addStringOption((opt) =>
    opt.setName("query").setDescription("Song name or search terms").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const member = interaction.member as GuildMember;
  const preferred = preferredChannelId();
  const targetChannelId = preferred ?? member.voice.channel?.id;

  if (!targetChannelId) {
    await interaction.editReply("You need to be in a voice channel first.");
    return;
  }

  const query = interaction.options.getString("query", true);

  let url: string;
  let title: string;
  let duration: number;
  try {
    const info = await searchVideo(query);
    url = info.url;
    title = info.title;
    duration = info.duration;
  } catch {
    await interaction.editReply(`No results found for **${query}**. Try a different search.`);
    return;
  }

  const guildId = interaction.guildId!;
  const guild = interaction.guild!;
  const textChannel = interaction.channel as GuildTextBasedChannel;

  let queue = getQueue(guildId);
  const wasPlaying = queue?.playing ?? false;

  if (!queue) queue = createQueue(guildId, targetChannelId, textChannel);

  queue.tracks.push({ url, title, duration, requestedBy: interaction.user.tag });

  // Keep panel updated when tracks auto-advance
  queue.onTrackStart = () => { void sendOrUpdatePanel(queue!); };

  try {
    await joinChannel(guild, targetChannelId, textChannel);
  } catch (err) {
    logger.error({ err, targetChannelId }, "search: failed to join voice channel");
    await interaction.editReply("❌ Failed to join voice channel. Check that the bot has **Connect** and **Speak** permissions in that channel.");
    return;
  }

  if (!wasPlaying) {
    await playNext(guildId);
    await interaction.editReply(`▶️ Now playing: **${title}**`);
    void sendOrUpdatePanel(queue);
  } else {
    const pos = queue.tracks.length;
    await interaction.editReply(`➕ Added to queue at position **#${pos}**: **${title}**`);
  }
}
