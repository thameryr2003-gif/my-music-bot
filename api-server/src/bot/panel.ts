import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { GuildQueue } from "./queue.js";
import { AUDIO_FILTERS, type AudioFilter } from "./ytdlp.js";
import { startPanelUpdater } from "../lib/panelUpdater.js";

export { AUDIO_FILTERS };
export type { AudioFilter };

const FILTER_EMOJI: Record<AudioFilter, string> = {
  Normal:    "🎵",
  BassBoost: "🔈",
  Nightcore: "⚡",
  Vaporwave: "🌊",
  "8D":      "🎧",
};

const FILTER_DESCRIPTION: Record<AudioFilter, string> = {
  Normal:    "No effects — original audio",
  BassBoost: "Heavy bass boost + normaliser",
  Nightcore: "Pitch & speed +25% (anime-style)",
  Vaporwave: "Pitch & speed −20% (lo-fi feel)",
  "8D":      "Rotating stereo panning effect",
};

function getYtThumbnail(url: string): string | null {
  try {
    const u = new URL(url);
    let id: string | null = null;
    if (u.hostname === "youtu.be") {
      id = u.pathname.slice(1).split("?")[0] ?? null;
    } else {
      id = u.searchParams.get("v");
    }
    return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${rem.toString().padStart(2, "0")}`;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

function buildProgressBar(elapsed: number, duration: number, width = 17): string {
  if (!duration || duration <= 0) return "▬".repeat(width);
  const ratio = Math.min(Math.max(elapsed / duration, 0), 1);
  const pos = Math.round(ratio * (width - 1));
  return "▬".repeat(pos) + "●" + "▬".repeat(width - 1 - pos);
}

export function buildEmbed(queue: GuildQueue): EmbedBuilder {
  const track = queue.tracks[0];
  if (!track) {
    return new EmbedBuilder()
      .setTitle("📻 Music Player")
      .setDescription("Queue is empty. Use `/play` or `/search` to add songs.")
      .setColor(0x2b2d31);
  }

  const elapsed = queue.startedAt
    ? queue.seekOffset + (Date.now() - queue.startedAt) / 1000
    : queue.seekOffset;

  const bar = buildProgressBar(elapsed, track.duration);
  const timeStr = track.duration > 0
    ? `\`${formatTime(elapsed)}\`  ${bar}  \`${formatTime(track.duration)}\``
    : `\`${formatTime(elapsed)}\`  ${bar}`;

  const volumePct = Math.round(queue.volume * 100);
  const volEmoji  = volumePct === 0 ? "🔇" : volumePct < 50 ? "🔉" : "🔊";
  const statusLabel = queue.paused ? "⏸  Paused" : "▶️  Playing";
  const loopStr     = queue.loop ? "🔁 On" : "🔁 Off";
  const filterStr   = `${FILTER_EMOJI[queue.filter]} ${queue.filter}`;
  const queueCount  = queue.tracks.length;

  // Footer: compact status line — appears below the image in Discord
  const footerText = `${volEmoji} ${volumePct}%  ·  ${loopStr}  ·  ${filterStr}  ·  ${queueCount} track${queueCount === 1 ? "" : "s"}`;

  const title = track.title.length > 256 ? track.title.slice(0, 253) + "…" : track.title;

  const embed = new EmbedBuilder()
    .setColor(queue.paused ? 0xfee75c : 0x1db954)
    .setAuthor({ name: statusLabel })
    .setTitle(title)
    .setURL(track.url)
    // Progress bar sits right under the title — before the image
    .setDescription(timeStr)
    .setFooter({ text: footerText });

  // setImage renders full-width below the description, above the footer
  const thumb = getYtThumbnail(track.url);
  if (thumb) embed.setImage(thumb);

  return embed;
}

export function buildRows(activeFilter: AudioFilter = "Normal", paused = false): ActionRowBuilder<ButtonBuilder>[] {
  const filterLabel = activeFilter === "Normal"
    ? "Filter 🎛"
    : `${FILTER_EMOJI[activeFilter]} ${activeFilter}`;

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("player:seek_back")
      .setEmoji("⏪")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player:pause")
      .setEmoji(paused ? "▶️" : "⏸️")
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("player:seek_forward")
      .setEmoji("⏩")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player:skip")
      .setEmoji("⏭️")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("player:stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("player:vol_down")
      .setLabel("Vol −")
      .setEmoji("🔉")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player:vol_up")
      .setLabel("Vol +")
      .setEmoji("🔊")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player:loop")
      .setEmoji("🔁")
      .setLabel("Loop")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player:filter")
      .setLabel(filterLabel)
      .setStyle(activeFilter === "Normal" ? ButtonStyle.Secondary : ButtonStyle.Primary),
  );

  return [row1, row2];
}

export function buildFilterSelectRow(
  activeFilter: AudioFilter
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("player:filter_select")
    .setPlaceholder("Choose an audio filter…")
    .addOptions(
      AUDIO_FILTERS.map((f) =>
        new StringSelectMenuOptionBuilder()
          .setValue(f)
          .setLabel(`${FILTER_EMOJI[f]}  ${f}`)
          .setDescription(FILTER_DESCRIPTION[f])
          .setDefault(f === activeFilter)
      )
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export async function sendOrUpdatePanel(queue: GuildQueue): Promise<void> {
  const embed = buildEmbed(queue);
  const components = buildRows(queue.filter, queue.paused);

  if (queue.panelMessage) {
    try {
      await queue.panelMessage.edit({ embeds: [embed], components });
    } catch {
      queue.panelMessage = null;
    }
  }

  if (!queue.panelMessage) {
    try {
      queue.panelMessage = await queue.textChannel.send({ embeds: [embed], components });
    } catch {
      return;
    }
  }

  if (queue.tracks.length > 0 && !queue.paused) {
    startPanelUpdater(queue.guildId, () => {
      void sendOrUpdatePanel(queue);
    }, 7000);
  }
}
