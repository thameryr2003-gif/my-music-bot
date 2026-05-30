import {
  AudioPlayer,
  AudioPlayerError,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Readable } from "node:stream";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { type AudioFilter, abandonStream, createAudioStream } from "./ytdlp.js";
import { logger } from "../lib/logger.js";
import { stopPanelUpdater } from "../lib/panelUpdater.js";

export interface Track {
  url: string;
  title: string;
  duration: number;
  requestedBy: string;
}

export interface GuildQueue {
  tracks: Track[];
  player: AudioPlayer;
  playing: boolean;
  paused: boolean;
  loop: boolean;
  volume: number;
  filter: AudioFilter;
  startedAt: number | null;
  seekOffset: number;
  currentResource: AudioResource | null;
  /** The raw Readable that feeds currentResource — used to detect superseded streams. */
  currentStream: Readable | null;
  panelMessage: Message | null;
  guildId: string;
  textChannel: GuildTextBasedChannel;
  voiceChannelId: string;
  onTrackStart?: () => void;
}

const queues = new Map<string, GuildQueue>();

export function getQueue(guildId: string): GuildQueue | undefined {
  return queues.get(guildId);
}

export function createQueue(
  guildId: string,
  voiceChannelId: string,
  textChannel: GuildTextBasedChannel
): GuildQueue {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  const queue: GuildQueue = {
    tracks: [],
    player,
    playing: false,
    paused: false,
    loop: false,
    volume: 1.0,
    filter: "Normal",
    startedAt: null,
    seekOffset: 0,
    currentResource: null,
    currentStream: null,
    panelMessage: null,
    guildId,
    textChannel,
    voiceChannelId,
  };
  queues.set(guildId, queue);
  return queue;
}

export function destroyQueue(guildId: string): void {
  stopPanelUpdater(guildId);
  const queue = queues.get(guildId);
  if (queue) {
    queue.player.removeAllListeners();
    queue.player.stop(true);
    abandonStream(queue.currentStream);
    queue.currentStream = null;
    queue.tracks = [];
    queue.playing = false;
    if (queue.panelMessage) {
      queue.panelMessage.edit({ components: [] }).catch(() => {});
      queue.panelMessage = null;
    }
  }
  const connection = getVoiceConnection(guildId);
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    connection.destroy();
  }
  queues.delete(guildId);
}

async function notify(queue: GuildQueue, message: string): Promise<void> {
  try {
    await queue.textChannel.send(message);
  } catch (err) {
    logger.warn({ err }, "Failed to send channel message");
  }
}

function attachPlayerListeners(queue: GuildQueue, stream: Readable): void {
  const { guildId } = queue;

  queue.player.once(AudioPlayerStatus.Idle, () => {
    const q = queues.get(guildId);
    if (!q) return;
    // Only advance if this stream is still the active one.
    // If it was superseded by a seek/filter change the Idle fires as a side-
    // effect of the player switching resources — don't act on it.
    if (q.currentStream !== stream) return;
    if (q.loop && q.tracks.length > 0) {
      playNext(guildId).catch(() => {});
    } else {
      q.tracks.shift();
      playNext(guildId).catch(() => {});
    }
  });

  queue.player.once("error", async (err: AudioPlayerError) => {
    const q = queues.get(guildId);
    if (!q) return;
    if (q.currentStream !== stream) return;
    logger.error({ err: err.message }, "AudioPlayer error");
    const track = q.tracks[0];
    if (track) {
      await notify(q, `❌ Playback error for **${track.title}** — skipping.`);
      q.tracks.shift();
    }
    await playNext(guildId);
  });

  // Guard: if THIS stream emits an error while it is still the current stream,
  // skip the track.  If it has already been superseded (seek/filter change),
  // abandonStream() will have removed all listeners so this will never fire.
  stream.once("error", async (err) => {
    const q = queues.get(guildId);
    if (!q || q.currentStream !== stream) return;
    logger.error({ err, track: q.tracks[0] }, "Audio stream error");
    const track = q.tracks[0];
    if (track) {
      await notify(q, `❌ Stream error for **${track.title}** — skipping.`);
      q.tracks.shift();
    }
    q.player.stop(true);
    await playNext(guildId);
  });
}

/**
 * Seek to an absolute timestamp (seconds) in the current track, optionally
 * with a new filter. Replaces the running stream without touching the queue.
 */
export async function seekTo(
  guildId: string,
  seconds: number,
  filter?: AudioFilter
): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue || queue.tracks.length === 0) return;

  const track = queue.tracks[0]!;
  const safeSecs = Math.max(0, seconds);

  // Apply new filter if provided
  if (filter !== undefined) queue.filter = filter;

  // ── Supersede the old stream BEFORE spawning the new process ─────────────
  // Removing listeners + destroying the old stream prevents ERR_STREAM_PREMATURE_CLOSE
  // from firing the skip logic when the player switches to the new resource.
  const oldStream = queue.currentStream;
  queue.currentStream = null; // signal: "no active stream right now"
  abandonStream(oldStream);

  let streamResult: ReturnType<typeof createAudioStream>;
  try {
    streamResult = createAudioStream(track.url, safeSecs, queue.filter);
  } catch (err) {
    logger.error({ err, track }, "Failed to create seek stream");
    return;
  }

  const { stream, streamType } = streamResult;

  const resource = createAudioResource(stream, {
    inputType: streamType,
    inlineVolume: true,
  });
  resource.volume?.setVolume(queue.volume);

  // Register the new stream as current BEFORE playing so Idle/error handlers
  // that fire synchronously can see the correct reference.
  queue.currentStream = stream;

  queue.player.removeAllListeners(AudioPlayerStatus.Idle);
  queue.player.removeAllListeners("error");

  queue.player.play(resource);
  queue.startedAt = Date.now();
  queue.seekOffset = safeSecs;
  queue.currentResource = resource;
  queue.paused = false;

  attachPlayerListeners(queue, stream);
}

export async function playNext(guildId: string): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.tracks.length === 0) {
    queue.playing = false;
    queue.startedAt = null;
    queue.seekOffset = 0;
    queue.currentResource = null;
    queue.currentStream = null;
    stopPanelUpdater(guildId);
    await notify(
      queue,
      "✅ Queue finished. I'm staying in the channel — add more songs with `/play` or `/search`."
    );
    return;
  }

  const track = queue.tracks[0]!;

  // Supersede any lingering stream from a previous track
  const oldStream = queue.currentStream;
  queue.currentStream = null;
  abandonStream(oldStream);

  let streamResult: ReturnType<typeof createAudioStream>;
  try {
    streamResult = createAudioStream(track.url, 0, queue.filter);
  } catch (err) {
    logger.error({ err, track }, "Failed to create audio stream");
    await notify(queue, `❌ Failed to load **${track.title}** — skipping.`);
    queue.tracks.shift();
    await playNext(guildId);
    return;
  }

  const { stream, streamType } = streamResult;

  // Register as current BEFORE playing
  queue.currentStream = stream;

  const resource = createAudioResource(stream, {
    inputType: streamType,
    inlineVolume: true,
  });
  resource.volume?.setVolume(queue.volume);

  queue.player.removeAllListeners(AudioPlayerStatus.Idle);
  queue.player.removeAllListeners("error");

  queue.player.play(resource);
  queue.playing = true;
  queue.paused = false;
  queue.startedAt = Date.now();
  queue.seekOffset = 0;
  queue.currentResource = resource;

  const connection = getVoiceConnection(guildId);
  if (connection) connection.subscribe(queue.player);

  attachPlayerListeners(queue, stream);

  queue.onTrackStart?.();
}
