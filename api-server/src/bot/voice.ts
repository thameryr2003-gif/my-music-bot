/**
 * Central voice connection manager.
 *
 * When TARGET_VOICE_CHANNEL_ID (or legacy VOICE_CHANNEL_ID) is set, the bot
 * is LOCKED to that channel — it always joins there and will rejoin if moved.
 */
import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Guild, GuildTextBasedChannel } from "discord.js";
import { logger } from "../lib/logger.js";

/**
 * Returns the locked channel ID if one is configured via env var.
 * Checks TARGET_VOICE_CHANNEL_ID first, then legacy VOICE_CHANNEL_ID.
 */
export function lockedChannelId(): string | undefined {
  return (
    process.env["TARGET_VOICE_CHANNEL_ID"] ??
    process.env["VOICE_CHANNEL_ID"] ??
    undefined
  );
}

/** @deprecated Use lockedChannelId() */
export function preferredChannelId(): string | undefined {
  return lockedChannelId();
}

/**
 * Join a voice channel. If a channel lock is configured the supplied
 * channelId is overridden — the bot always ends up in the locked channel.
 */
export async function joinChannel(
  guild: Guild,
  channelId: string,
  textChannel: GuildTextBasedChannel
): Promise<VoiceConnection> {
  const locked = lockedChannelId();
  const targetId = locked ?? channelId;

  if (locked && locked !== channelId) {
    logger.info(
      { requested: channelId, locked },
      "Channel lock active — redirecting to locked channel"
    );
  }

  let connection = getVoiceConnection(guild.id);

  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = joinVoiceChannel({
      channelId: targetId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    attachResilienceHandler(connection, guild, targetId, textChannel);
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    logger.error(
      { err, channelId: targetId, guildId: guild.id },
      "Failed to reach Ready state when joining voice channel — check bot permissions (Connect + Speak) and that the channel ID is correct"
    );
    throw err;
  }
  return connection;
}

function attachResilienceHandler(
  connection: VoiceConnection,
  guild: Guild,
  channelId: string,
  textChannel: GuildTextBasedChannel
): void {
  connection.on("stateChange", async (oldState, newState) => {
    logger.info(
      { from: oldState.status, to: newState.status },
      "Voice connection state change"
    );

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      // Give it 5 s to self-recover before forcing a rejoin.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Self-recovered — nothing to do.
      } catch {
        if (connection.state.status === VoiceConnectionStatus.Disconnected) {
          logger.warn("Voice disconnected — attempting rejoin");
          try {
            connection.rejoin({ channelId, selfDeaf: true, selfMute: false });
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
            logger.info("Rejoined voice channel");
          } catch (err) {
            logger.error({ err }, "Failed to rejoin — rebuilding connection");
            try {
              const fresh = joinVoiceChannel({
                channelId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true,
                selfMute: false,
              });
              attachResilienceHandler(fresh, guild, channelId, textChannel);
              await entersState(fresh, VoiceConnectionStatus.Ready, 10_000);
              logger.info("Rebuilt voice connection");
            } catch (err2) {
              logger.error({ err: err2 }, "Could not rebuild voice connection");
            }
          }
        }
      }
    }

    if (newState.status === VoiceConnectionStatus.Destroyed) {
      logger.info("Voice connection destroyed");
    }
  });
}
