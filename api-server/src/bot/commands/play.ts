import {
  ChatInputCommandInteraction,
  GuildMember,
  GuildTextBasedChannel,
  SlashCommandBuilder,
} from "discord.js";
import {
  getVideoInfo,
  getPlaylistTracks,
  isPlaylistURL,
  validateYouTubeURL,
} from "../ytdlp.js";
import { createQueue, getQueue, playNext, type Track } from "../queue.js";
import { joinChannel, preferredChannelId } from "../voice.js";
import { sendOrUpdatePanel } from "../panel.js";
import { logger } from "../../lib/logger.js";

export const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play a YouTube video or playlist URL")
  .addStringOption((opt) =>
    opt.setName("url").setDescription("YouTube URL (video or playlist)").setRequired(true)
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

  const url = interaction.options.getString("url", true);

  if (!validateYouTubeURL(url)) {
    await interaction.editReply("Please provide a valid YouTube URL.");
    return;
  }

  const guildId = interaction.guildId!;
  const guild = interaction.guild!;
  const textChannel = interaction.channel as GuildTextBasedChannel;

  // ── Playlist ──────────────────────────────────────────────────────────────
  if (isPlaylistURL(url)) {
    await interaction.editReply("🎶 Fetching playlist… this may take a moment.");

    let tracks: Track[];
    try {
      const infos = await getPlaylistTracks(url);
      if (infos.length === 0) {
        await interaction.editReply("Could not find any tracks in that playlist.");
        return;
      }
      tracks = infos.map((t) => ({
        url: t.url,
        title: t.title,
        duration: t.duration,
        requestedBy: interaction.user.tag,
      }));
    } catch {
      await interaction.editReply("Could not fetch playlist. Check the URL and try again.");
      return;
    }

    let q = getQueue(guildId);
    const wasPlaying = q?.playing ?? false;

    if (!q) q = createQueue(guildId, targetChannelId, textChannel);

    q.tracks.push(...tracks);
    q.onTrackStart = () => { void sendOrUpdatePanel(q!); };

    try {
      await joinChannel(guild, targetChannelId, textChannel);
    } catch (err) {
      logger.error({ err, targetChannelId }, "play: failed to join voice channel");
      await interaction.editReply("❌ Failed to join voice channel. Check that the bot has **Connect** and **Speak** permissions in that channel.");
      return;
    }

    if (!wasPlaying) {
      await playNext(guildId);
      void sendOrUpdatePanel(q);
    }

    await interaction.editReply(
      `✅ Added **${tracks.length} tracks** from the playlist to the queue.${wasPlaying ? "" : `\n▶️ Now playing: **${tracks[0]!.title}**`}`
    );
    return;
  }

  // ── Single video ──────────────────────────────────────────────────────────
  let title: string;
  let duration: number;
  try {
    const info = await getVideoInfo(url);
    title = info.title;
    duration = info.duration;
  } catch {
    await interaction.editReply("Could not fetch video info. Check the URL and try again.");
    return;
  }

  let q = getQueue(guildId);
  const wasPlaying = q?.playing ?? false;

  if (!q) q = createQueue(guildId, targetChannelId, textChannel);

  q.tracks.push({ url, title, duration, requestedBy: interaction.user.tag });
  q.onTrackStart = () => { void sendOrUpdatePanel(q!); };

  try {
    await joinChannel(guild, targetChannelId, textChannel);
  } catch (err) {
    logger.error({ err, targetChannelId }, "play: failed to join voice channel");
    await interaction.editReply("❌ Failed to join voice channel. Check that the bot has **Connect** and **Speak** permissions in that channel.");
    return;
  }

  if (!wasPlaying) {
    await playNext(guildId);
    await interaction.editReply(`▶️ Now playing: **${title}**`);
    void sendOrUpdatePanel(q);
  } else {
    const pos = q.tracks.length;
    await interaction.editReply(`➕ Added to queue at position **#${pos}**: **${title}**`);
  }
}
