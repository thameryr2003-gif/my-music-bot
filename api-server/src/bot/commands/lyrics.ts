import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { getQueue } from "../queue.js";
import { logger } from "../../lib/logger.js";

// ── Config ────────────────────────────────────────────────────────────────────
const PAGE_CHARS = 3800; // safe under Discord's 4096-char description limit

function boundChannelId(): string {
  return (
    process.env["ALLOWED_TEXT_CHANNEL_ID"] ??
    process.env["TARGET_TEXT_CHANNEL_ID"] ??
    process.env["VOICE_CHANNEL_ID"] ??
    ""
  );
}

// ── In-memory page cache (15-min TTL) ────────────────────────────────────────
interface LyricsCacheEntry {
  pages: string[];
  title: string;
  expires: number;
}
export const lyricsCache = new Map<string, LyricsCacheEntry>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [k, v] of lyricsCache) {
    if (v.expires < now) lyricsCache.delete(k);
  }
}

// ── Title parsing ─────────────────────────────────────────────────────────────
function parseSongTitle(raw: string): { artist: string; title: string } {
  // Strip common YouTube suffixes like (Official Video), [Lyrics], etc.
  const clean = raw
    .replace(/\s*[\(\[][^\)\]]*?(official|video|audio|lyric|hd|4k|mv|clip|music)[^\)\]]*[\)\]]/gi, "")
    .trim();
  const parts = clean.split(/\s*[-–]\s*/);
  if (parts.length >= 2) {
    return { artist: parts[0]!.trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { artist: "", title: clean };
}

// ── Lyrics fetchers ───────────────────────────────────────────────────────────
async function fromLrclib(artist: string, title: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist) params.set("artist_name", artist);
    const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ plainLyrics?: string }>;
    return data[0]?.plainLyrics ?? null;
  } catch (err) {
    logger.warn({ err }, "lyrics: lrclib fetch failed");
    return null;
  }
}

async function fromLyricsOvh(artist: string, title: string): Promise<string | null> {
  if (!artist || !title) return null;
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { lyrics?: string; error?: string };
    if (data.error || !data.lyrics) return null;
    return data.lyrics;
  } catch (err) {
    logger.warn({ err }, "lyrics: lyrics.ovh fetch failed");
    return null;
  }
}

async function fetchLyrics(rawTitle: string): Promise<string | null> {
  const { artist, title } = parseSongTitle(rawTitle);
  const searchTitle = title || rawTitle;

  const result =
    (await fromLrclib(artist, searchTitle)) ??
    (await fromLyricsOvh(artist, searchTitle)) ??
    (artist ? await fromLrclib("", rawTitle) : null);

  return result;
}

// ── Page helpers ──────────────────────────────────────────────────────────────
function splitPages(text: string): string[] {
  const lines = text.split("\n");
  const pages: string[] = [];
  let cur = "";
  for (const line of lines) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > PAGE_CHARS) {
      if (cur) pages.push(cur.trim());
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) pages.push(cur.trim());
  return pages.length > 0 ? pages : [text.slice(0, PAGE_CHARS)];
}

// ── Embed / button builders (exported for button handler in index.ts) ─────────
export function buildLyricsEmbed(
  title: string,
  pages: string[],
  pageIdx: number
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🎵 ${title}`)
    .setDescription(pages[pageIdx] ?? "No lyrics content.")
    .setColor(0x5865f2);
  if (pages.length > 1) {
    embed.setFooter({ text: `Page ${pageIdx + 1} of ${pages.length}` });
  }
  return embed;
}

export function buildLyricsRow(
  cacheKey: string,
  pageIdx: number,
  totalPages: number
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`lyrics:prev:${pageIdx}:${cacheKey}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIdx === 0),
    new ButtonBuilder()
      .setCustomId(`lyrics:next:${pageIdx}:${cacheKey}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIdx === totalPages - 1)
  );
}

// ── Slash command ─────────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("lyrics")
  .setDescription("Show lyrics for the currently playing song");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.channelId !== boundChannelId()) {
    await interaction.reply({
      content: "❌ This command can only be used in the music channel.",
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Not in a server.", ephemeral: true });
    return;
  }

  const q = getQueue(guildId);
  if (!q || q.tracks.length === 0 || !q.playing) {
    await interaction.reply({
      content: "🎵 No song is currently playing.",
      ephemeral: true,
    });
    return;
  }

  const currentTrack = q.tracks[0]!;
  await interaction.deferReply();

  const lyricsText = await fetchLyrics(currentTrack.title);

  if (!lyricsText) {
    await interaction.editReply(
      `❌ Couldn't find lyrics for **${currentTrack.title}**.\n` +
      `Try searching on [Genius](https://genius.com) or [AZLyrics](https://www.azlyrics.com).`
    );
    return;
  }

  const pages = splitPages(lyricsText);

  if (pages.length === 1) {
    await interaction.editReply({ embeds: [buildLyricsEmbed(currentTrack.title, pages, 0)] });
    return;
  }

  purgeExpired();
  const cacheKey = `${guildId}_${Date.now()}`;
  lyricsCache.set(cacheKey, {
    pages,
    title: currentTrack.title,
    expires: Date.now() + 15 * 60_000,
  });

  await interaction.editReply({
    embeds: [buildLyricsEmbed(currentTrack.title, pages, 0)],
    components: [buildLyricsRow(cacheKey, 0, pages.length)],
  });
}
