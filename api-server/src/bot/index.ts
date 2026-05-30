import {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { handleShCommand, handleSearchSelect } from "./prefixSearch.js";
import * as lyricsCmd from "./commands/lyrics.js";
import { lyricsCache, buildLyricsEmbed, buildLyricsRow } from "./commands/lyrics.js";
import { getVoiceConnection, joinVoiceChannel } from "@discordjs/voice";
import { logger } from "../lib/logger.js";
import { updateYtDlp, AUDIO_FILTERS, type AudioFilter } from "./ytdlp.js";
import { getQueue, playNext, seekTo } from "./queue.js";
import { buildEmbed, buildFilterSelectRow, buildRows, sendOrUpdatePanel } from "./panel.js";
import { stopPanelUpdater, startPanelUpdater } from "../lib/panelUpdater.js";
import { lockedChannelId } from "./voice.js";
import * as play from "./commands/play.js";
import * as skip from "./commands/skip.js";
import * as pause from "./commands/pause.js";
import * as stop from "./commands/stop.js";
import * as leave from "./commands/leave.js";
import * as queue from "./commands/queue.js";
import * as nowplaying from "./commands/nowplaying.js";
import * as search from "./commands/search.js";

interface Command {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

const commands = new Collection<string, Command>();
for (const cmd of [play, skip, pause, stop, leave, queue, nowplaying, search, lyricsCmd]) {
  commands.set(cmd.data.name, cmd as Command);
}
// Arabic alias — same execute function as /play
commands.set("ش", play as Command);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  logger.info(`Discord bot ready as ${c.user.tag}`);
  updateYtDlp();
});

// ── Move-back Guard ───────────────────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.member?.user.id !== client.user?.id) return;
  const locked = lockedChannelId();
  if (!locked) return;

  const guildId = newState.guild.id;
  const currentChannelId = newState.channelId;

  if (currentChannelId && currentChannelId !== locked) {
    logger.warn(
      { from: currentChannelId, to: locked },
      "Move-back guard: bot was moved — rejoining locked channel"
    );
    const connection = getVoiceConnection(guildId);
    if (connection) {
      try {
        connection.rejoin({ channelId: locked, selfDeaf: true, selfMute: false });
      } catch (err) {
        logger.error({ err }, "Move-back guard: rejoin failed — rebuilding connection");
        const fresh = joinVoiceChannel({
          channelId: locked,
          guildId,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        });
        fresh.on("error", (e) => logger.error({ err: e }, "Move-back guard: new connection error"));
      }
    }
  }
});

// ── Button handler ────────────────────────────────────────────────────────────
async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Not in a server.", ephemeral: true });
    return;
  }

  const q = getQueue(guildId);

  // ── Lyrics pagination buttons ──────────────────────────────────────────────
  if (interaction.customId.startsWith("lyrics:")) {
    const parts = interaction.customId.split(":");
    const direction = parts[1] as "prev" | "next";
    const currentPage = parseInt(parts[2] ?? "0", 10);
    const cacheKey = parts[3] ?? "";
    const entry = lyricsCache.get(cacheKey);
    if (!entry || entry.expires < Date.now()) {
      await interaction.reply({ content: "⏱️ Lyrics session expired. Run `/lyrics` again.", ephemeral: true });
      return;
    }
    const newPage = direction === "next" ? currentPage + 1 : currentPage - 1;
    const clamped = Math.max(0, Math.min(newPage, entry.pages.length - 1));
    const embed = buildLyricsEmbed(entry.title, entry.pages, clamped);
    const row = buildLyricsRow(cacheKey, clamped, entry.pages.length);
    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  // ── Filter button: open ephemeral select menu ──────────────────────────────
  if (interaction.customId === "player:filter") {
    if (!q || q.tracks.length === 0) {
      await interaction.reply({ content: "Nothing is playing right now.", ephemeral: true });
      return;
    }
    const selectRow = buildFilterSelectRow(q.filter);
    await interaction.reply({
      content: "### 🎛 Choose an audio filter",
      components: [selectRow],
      ephemeral: true,
    });
    return;
  }

  if (!q || q.tracks.length === 0) {
    await interaction.update({ content: "Nothing is playing right now.", embeds: [], components: [] });
    return;
  }

  const id = interaction.customId;

  switch (id) {
    case "player:pause": {
      if (q.paused) {
        // Resume — restart the clock from the frozen seek offset
        q.player.unpause();
        q.paused = false;
        q.startedAt = Date.now();
        // Restart periodic panel updater
        startPanelUpdater(guildId, () => { void sendOrUpdatePanel(q); }, 7000);
      } else {
        // Pause — freeze elapsed time into seekOffset
        if (q.startedAt !== null) {
          q.seekOffset = q.seekOffset + (Date.now() - q.startedAt) / 1000;
          q.startedAt = null;
        }
        q.player.pause();
        q.paused = true;
        // Stop periodic updates while paused
        stopPanelUpdater(guildId);
      }
      break;
    }
    case "player:skip": {
      q.tracks.shift();
      q.player.stop();
      if (q.tracks.length > 0) await playNext(guildId);
      break;
    }
    case "player:stop": {
      q.tracks = [];
      q.player.stop(true);
      q.playing = false;
      q.paused = false;
      q.panelMessage = null;
      stopPanelUpdater(guildId);
      await interaction.update({ content: "⏹️ Stopped playback and cleared the queue.", embeds: [], components: [] });
      return;
    }
    case "player:loop": {
      q.loop = !q.loop;
      break;
    }
    case "player:vol_down": {
      q.volume = Math.max(0, Math.round((q.volume - 0.1) * 10) / 10);
      q.currentResource?.volume?.setVolume(q.volume);
      break;
    }
    case "player:vol_up": {
      q.volume = Math.min(1.5, Math.round((q.volume + 0.1) * 10) / 10);
      q.currentResource?.volume?.setVolume(q.volume);
      break;
    }
    case "player:seek_back":
    case "player:seek_forward": {
      const elapsed = q.startedAt
        ? q.seekOffset + (Date.now() - q.startedAt) / 1000
        : q.seekOffset;
      const delta = id === "player:seek_back" ? -10 : 10;
      await seekTo(guildId, elapsed + delta);
      break;
    }
    default:
      break;
  }

  if (!q.playing && q.tracks.length === 0) {
    await interaction.update({ content: "✅ Queue finished.", embeds: [], components: [] });
    return;
  }

  const embed = buildEmbed(q);
  await interaction.update({ embeds: [embed], components: buildRows(q.filter, q.paused) });
}

// ── Select Menu handlers ──────────────────────────────────────────────────────
async function handleFilterSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.update({ content: "Not in a server.", components: [] });
    return;
  }

  const q = getQueue(guildId);
  if (!q || q.tracks.length === 0) {
    await interaction.update({ content: "Nothing is playing right now.", components: [] });
    return;
  }

  const chosen = interaction.values[0] as AudioFilter | undefined;
  if (!chosen || !AUDIO_FILTERS.includes(chosen)) {
    await interaction.update({ content: "Unknown filter.", components: [] });
    return;
  }

  await interaction.update({ content: `Applying **${chosen}** filter…`, components: [] });

  const elapsed = q.startedAt
    ? q.seekOffset + (Date.now() - q.startedAt) / 1000
    : q.seekOffset;

  await seekTo(guildId, elapsed, chosen);

  logger.info({ filter: chosen, guildId }, "Audio filter applied via select menu");

  const embed = buildEmbed(q);
  if (q.panelMessage) {
    q.panelMessage.edit({ embeds: [embed], components: buildRows(q.filter, q.paused) }).catch(() => {});
  }
}

// ── Interaction router ────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    try {
      await handleButton(interaction);
    } catch (err) {
      logger.error({ err }, "Button interaction error");
    }
    return;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "player:filter_select") {
      try {
        await handleFilterSelect(interaction);
      } catch (err) {
        logger.error({ err }, "Filter select interaction error");
        interaction.update({ content: "An error occurred applying the filter.", components: [] }).catch(() => {});
      }
      return;
    }

    if (interaction.customId.startsWith("search:pick:")) {
      try {
        await handleSearchSelect(interaction);
      } catch (err) {
        logger.error({ err }, "Search select interaction error");
        interaction.update({ content: "An error occurred. Please try again.", components: [] }).catch(() => {});
      }
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) {
    logger.warn({ command: interaction.commandName }, "Unknown command");
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error({ err, command: interaction.commandName }, "Command error");
    const msg = { content: "An error occurred while running that command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ── ش prefix command ──────────────────────────────────────────────────────────
client.on(Events.MessageCreate, (message) => {
  if (message.content.startsWith("ش")) {
    handleShCommand(message).catch((err: unknown) => {
      logger.error({ err }, "ش prefix command error");
    });
  }
});

export function startBot(): void {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_TOKEN not set — bot will not start");
    return;
  }
  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to login to Discord");
  });
}
