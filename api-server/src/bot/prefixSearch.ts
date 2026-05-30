/**
 * Prefix command handler for "ش" (Arabic shin).
 *
 * Usage:  ش <search query>   → shows top-5 results as a StringSelectMenu
 *         ش <youtube URL>    → plays immediately
 *
 * Only responds in ALLOWED_TEXT_CHANNEL_ID (env var).
 * Requires the MessageContent privileged intent to be enabled.
 */
import {
  type Message,
  type GuildMember,
  type GuildTextBasedChannel,
  type Guild,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  searchVideos,
  getVideoInfo,
  getPlaylistTracks,
  isPlaylistURL,
  validateYouTubeURL,
  type VideoInfo,
} from "./ytdlp.js";
import { createQueue, getQueue, playNext, type Track } from "./queue.js";
import { joinChannel, preferredChannelId } from "./voice.js";
import { sendOrUpdatePanel } from "./panel.js";
import { logger } from "../lib/logger.js";

/** The text channel where ش commands are accepted. */
function boundChannelId(): string {
  return (
    process.env["ALLOWED_TEXT_CHANNEL_ID"] ??
    process.env["TARGET_TEXT_CHANNEL_ID"] ??
    process.env["VOICE_CHANNEL_ID"] ??
    ""
  );
}

function fmt(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "?:??";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Search result cache ───────────────────────────────────────────────────────

interface SearchCacheEntry {
  results: VideoInfo[];
  voiceChannelId: string;
  requestedBy: string;
  guild: Guild;
  textChannel: GuildTextBasedChannel;
  expires: number;
}

export const searchCache = new Map<string, SearchCacheEntry>();

// ── Shared enqueue helper ─────────────────────────────────────────────────────

export async function enqueueAndPlay(
  guildId: string,
  guild: Guild,
  textChannel: GuildTextBasedChannel,
  tracks: Track[],
  voiceChannelId: string,
  statusMsg: Message
): Promise<void> {
  let q = getQueue(guildId);
  const wasPlaying = q?.playing ?? false;

  if (!q) q = createQueue(guildId, voiceChannelId, textChannel);

  q.tracks.push(...tracks);
  q.onTrackStart = () => { void sendOrUpdatePanel(q!); };

  try {
    await joinChannel(guild, voiceChannelId, textChannel);
  } catch (err) {
    logger.error({ err, voiceChannelId }, "ش: failed to join voice channel");
    await statusMsg.edit("❌ Failed to join voice channel. Check that the bot has **Connect** and **Speak** permissions in that channel.").catch(() => {});
    return;
  }

  if (!wasPlaying) {
    await playNext(guildId);
    void sendOrUpdatePanel(q);
    if (tracks.length === 1) {
      await statusMsg.edit(`▶️ Now playing: **${tracks[0]!.title}**`).catch(() => {});
    } else {
      await statusMsg.edit(
        `✅ Added **${tracks.length} tracks** to the queue.\n▶️ Now playing: **${tracks[0]!.title}**`
      ).catch(() => {});
    }
  } else {
    if (tracks.length === 1) {
      const pos = (getQueue(guildId)?.tracks.length ?? 1);
      await statusMsg.edit(`➕ Added to queue at position **#${pos}**: **${tracks[0]!.title}**`).catch(() => {});
    } else {
      await statusMsg.edit(`➕ Added **${tracks.length} tracks** to the queue.`).catch(() => {});
    }
  }
}

// ── Search select menu handler (called from index.ts) ────────────────────────

export async function handleSearchSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const msgId = interaction.customId.replace("search:pick:", "");
  const entry = searchCache.get(msgId);

  if (!entry || entry.expires < Date.now()) {
    searchCache.delete(msgId);
    await interaction.update({ content: "⏱️ Search session expired. Try again.", components: [] });
    return;
  }

  const idx = parseInt(interaction.values[0] ?? "0", 10);
  const chosen = entry.results[idx];
  if (!chosen) {
    await interaction.update({ content: "❌ Invalid selection.", components: [] });
    return;
  }

  await interaction.update({ content: `⏳ Loading: **${chosen.title}**…`, components: [] });
  searchCache.delete(msgId);

  let info: VideoInfo;
  try {
    info = await getVideoInfo(chosen.url);
  } catch (err) {
    logger.error({ err }, "ش select: video info fetch failed");
    await interaction.editReply("❌ Could not load that video. Try another.").catch(() => {});
    return;
  }

  const track: Track = {
    url: info.url,
    title: info.title,
    duration: info.duration,
    requestedBy: entry.requestedBy,
  };

  const guildId = interaction.guildId!;

  let q = getQueue(guildId);
  const wasPlaying = q?.playing ?? false;

  if (!q) q = createQueue(guildId, entry.voiceChannelId, entry.textChannel);
  q.tracks.push(track);
  q.onTrackStart = () => { void sendOrUpdatePanel(q!); };

  try {
    await joinChannel(entry.guild, entry.voiceChannelId, entry.textChannel);
  } catch (err) {
    logger.error({ err, voiceChannelId: entry.voiceChannelId }, "ش select: failed to join voice channel");
    await interaction.editReply("❌ Failed to join voice channel.").catch(() => {});
    return;
  }

  if (!wasPlaying) {
    await playNext(guildId);
    void sendOrUpdatePanel(q);
    await interaction.editReply(`▶️ Now playing: **${info.title}**`).catch(() => {});
  } else {
    const pos = getQueue(guildId)?.tracks.length ?? 1;
    await interaction.editReply(`➕ Added to queue at position **#${pos}**: **${info.title}**`).catch(() => {});
  }
}

// ── Main prefix handler ───────────────────────────────────────────────────────

export async function handleShCommand(message: Message): Promise<void> {
  if (message.channelId !== boundChannelId()) return;
  if (!message.guild) return;
  if (message.author.bot) return;

  const content = message.content.replace(/^ش\s*/u, "").trim();
  if (!content) {
    await message.reply("Usage: `ش <search terms>` or `ش <YouTube URL>`").catch(() => {});
    return;
  }

  const member = message.member as GuildMember | null;
  const preferred = preferredChannelId();
  const voiceChannelId = preferred ?? member?.voice.channel?.id;

  if (!voiceChannelId) {
    await message.reply("❌ Join a voice channel first.").catch(() => {});
    return;
  }

  const guildId = message.guild.id;
  const guild = message.guild;
  const textChannel = message.channel as GuildTextBasedChannel;

  // ── Direct YouTube URL ────────────────────────────────────────────────────
  if (validateYouTubeURL(content)) {
    const statusMsg = await message.reply("🔍 Fetching info…");

    if (isPlaylistURL(content)) {
      await statusMsg.edit("📋 Fetching playlist… this may take a moment.");
      let infos: VideoInfo[];
      try {
        infos = await getPlaylistTracks(content);
      } catch (err) {
        logger.error({ err }, "ش: playlist fetch failed");
        await statusMsg.edit("❌ Could not fetch playlist. Check the URL and try again.").catch(() => {});
        return;
      }
      if (infos.length === 0) {
        await statusMsg.edit("❌ No tracks found in that playlist.").catch(() => {});
        return;
      }
      const tracks: Track[] = infos.map((t) => ({
        url: t.url,
        title: t.title,
        duration: t.duration,
        requestedBy: message.author.tag,
      }));
      await enqueueAndPlay(guildId, guild, textChannel, tracks, voiceChannelId, statusMsg);
    } else {
      let info: VideoInfo;
      try {
        info = await getVideoInfo(content);
      } catch (err) {
        logger.error({ err }, "ش: video info fetch failed");
        await statusMsg.edit("❌ Could not fetch video info. Check the URL and try again.").catch(() => {});
        return;
      }
      const track: Track = {
        url: info.url,
        title: info.title,
        duration: info.duration,
        requestedBy: message.author.tag,
      };
      await enqueueAndPlay(guildId, guild, textChannel, [track], voiceChannelId, statusMsg);
    }
    return;
  }

  // ── Text search → StringSelectMenu ───────────────────────────────────────
  const statusMsg = await message.reply("🔍 Searching YouTube…");

  let results: VideoInfo[];
  try {
    results = await searchVideos(content, 5);
  } catch (err) {
    logger.error({ err }, "ش: search failed");
    await statusMsg.edit("❌ Search failed. Please try again.").catch(() => {});
    return;
  }

  if (results.length === 0) {
    await statusMsg.edit("❌ No results found for that query.").catch(() => {});
    return;
  }

  // Store results in cache keyed by message ID (60s TTL)
  searchCache.set(statusMsg.id, {
    results,
    voiceChannelId,
    requestedBy: message.author.tag,
    guild,
    textChannel,
    expires: Date.now() + 60_000,
  });

  // Auto-expire cache entry
  setTimeout(() => {
    if (searchCache.has(statusMsg.id)) {
      searchCache.delete(statusMsg.id);
      statusMsg.edit({ content: "⏱️ Search expired.", components: [] }).catch(() => {});
    }
  }, 60_000);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`search:pick:${statusMsg.id}`)
    .setPlaceholder("🎵 Pick a song to play…")
    .addOptions(
      results.map((r, i) =>
        new StringSelectMenuOptionBuilder()
          .setValue(String(i))
          .setLabel(r.title.length > 100 ? r.title.slice(0, 97) + "…" : r.title)
          .setDescription(`⏱ ${fmt(r.duration)}`)
      )
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

  await statusMsg.edit({
    content: `🎵 **Results for:** \`${content}\`\nSelect a song from the menu below:`,
    components: [row],
  });
}
