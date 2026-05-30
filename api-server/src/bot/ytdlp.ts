import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import ffmpegStatic from "ffmpeg-static";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

const YTDLP = "yt-dlp";
const FFMPEG = ffmpegStatic ?? "ffmpeg";
const BASE: string[] = [];

export type AudioFilter = "Normal" | "BassBoost" | "Nightcore" | "Vaporwave" | "8D";
export const AUDIO_FILTERS: AudioFilter[] = ["Normal", "BassBoost", "Nightcore", "Vaporwave", "8D"];

const FILTER_PRESETS: Record<Exclude<AudioFilter, "Normal">, string> = {
  BassBoost: "bass=g=15,dynaudnorm=f=200",
  Nightcore: "asetrate=48000*1.25,aresample=48000,atempo=1.06",
  Vaporwave: "asetrate=48000*0.8,aresample=48000,atempo=0.9",
  "8D": "apulsator=hz=0.125",
};

export interface VideoInfo {
  title: string;
  duration: number;
  url: string;
}

export interface AudioStreamResult {
  stream: Readable;
  streamType: StreamType;
}

/** yt-dlp outputs progress lines before the JSON — grab only the last non-empty line. */
function parseLastJson(stdout: string): { title: string; duration: number; webpage_url: string } {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{")) {
      return JSON.parse(line) as { title: string; duration: number; webpage_url: string };
    }
  }
  throw new Error("No JSON found in yt-dlp output");
}

/** Run yt-dlp -U in the background at startup — non-blocking. */
export function updateYtDlp(): void {
  const proc = spawn(YTDLP, [...BASE, "-U"], { stdio: "ignore" });
  proc.on("close", (code) => {
    if (code === 0) {
      logger.info("yt-dlp updated successfully");
    } else {
      logger.info("yt-dlp already on latest version");
    }
  });
  proc.on("error", (err) => {
    logger.warn({ err }, "yt-dlp auto-update failed");
  });
}

const YT_CLIENT = ["--extractor-args", "youtube:player_client=android"];
const INFO_FLAGS = ["--dump-json", "--no-check-formats", "--no-playlist", ...YT_CLIENT];

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const { stdout } = await execFileAsync(
    YTDLP,
    [...BASE, ...INFO_FLAGS, "--", url],
    { timeout: 30_000 }
  );
  const data = parseLastJson(stdout);
  return { title: data.title, duration: data.duration, url: data.webpage_url };
}

/** Search YouTube and return the first result. */
export async function searchVideo(query: string): Promise<VideoInfo> {
  const { stdout } = await execFileAsync(
    YTDLP,
    [...BASE, ...INFO_FLAGS, `ytsearch1:${query}`],
    { timeout: 30_000 }
  );
  const data = parseLastJson(stdout);
  return { title: data.title, duration: data.duration, url: data.webpage_url };
}

/** Search YouTube and return up to `count` results (default 5).
 *
 * Uses --flat-playlist so yt-dlp reads the search-results page without
 * invoking the video player API — the same path used for playlists and far
 * less likely to be blocked by YouTube's bot-detection.
 */
export async function searchVideos(query: string, count = 5): Promise<VideoInfo[]> {
  const { stdout } = await execFileAsync(
    YTDLP,
    [
      ...BASE,
      "--flat-playlist",
      "--dump-json",
      "--playlist-end", String(count),
      `ytsearch${count}:${query}`,
    ],
    { timeout: 45_000 }
  );
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return lines
    .map((line) => {
      const d = JSON.parse(line) as {
        title?: string;
        duration?: number;
        url?: string;
        webpage_url?: string;
        id?: string;
      };
      const url =
        d.webpage_url ??
        d.url ??
        (d.id ? `https://www.youtube.com/watch?v=${d.id}` : "");
      return {
        title: d.title ?? "Unknown",
        duration: d.duration ?? 0,
        url,
      };
    })
    .filter((v) => v.url !== "");
}

/** Returns true if the URL is a YouTube playlist (has list= param but no v=). */
export function isPlaylistURL(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "www.youtube.com" ||
        u.hostname === "youtube.com" ||
        u.hostname === "music.youtube.com") &&
      u.searchParams.has("list") &&
      !u.searchParams.has("v")
    );
  } catch {
    return false;
  }
}

/**
 * Fetch all tracks from a YouTube playlist (up to 200 entries).
 * Uses --flat-playlist for speed — no video download.
 */
export async function getPlaylistTracks(url: string): Promise<VideoInfo[]> {
  const { stdout } = await execFileAsync(
    YTDLP,
    [
      ...BASE,
      "--flat-playlist",
      "--dump-json",
      "--no-check-formats",
      "--playlist-end", "200",
      ...YT_CLIENT,
      "--", url,
    ],
    { timeout: 60_000 }
  );

  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  return lines.map((line) => {
    const d = JSON.parse(line) as {
      title?: string;
      duration?: number;
      url?: string;
      webpage_url?: string;
      id?: string;
    };
    const videoUrl =
      d.webpage_url ??
      d.url ??
      (d.id ? `https://www.youtube.com/watch?v=${d.id}` : "");
    return {
      title: d.title ?? "Unknown",
      duration: d.duration ?? 0,
      url: videoUrl,
    };
  }).filter((t) => t.url !== "");
}

export function validateYouTubeURL(url: string): boolean {
  try {
    const u = new URL(url);
    const isYT =
      u.hostname === "www.youtube.com" ||
      u.hostname === "youtube.com" ||
      u.hostname === "youtu.be" ||
      u.hostname === "music.youtube.com";
    if (!isYT) return false;
    if (u.searchParams.has("v")) return true;
    if (u.pathname.startsWith("/shorts/")) return true;
    if (u.hostname === "youtu.be") return true;
    if (u.searchParams.has("list")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Gracefully tears down a stream that is being superseded (e.g. on seek/filter
 * change). Removes all error listeners first so the pipeline's premature-close
 * signal does NOT propagate and trigger skip logic.
 */
export function abandonStream(stream: Readable | null): void {
  if (!stream) return;
  stream.removeAllListeners("error");
  stream.removeAllListeners("close");
  stream.removeAllListeners("end");
  // Suppress any future errors on this stream (EPIPE, premature-close, etc.)
  stream.on("error", () => {});
  // Destroy it so the underlying yt-dlp / ffmpeg process exits promptly
  if (!stream.destroyed) stream.destroy();
}

/**
 * Spawn yt-dlp and pipe audio to stdout.
 *
 * When filter !== "Normal", the stream is piped through ffmpeg with the
 * appropriate -af chain and output as raw s16le PCM (StreamType.Raw).
 * When filter === "Normal", yt-dlp stdout is returned directly (StreamType.Arbitrary).
 *
 * The yt-dlp Android user-agent extractor arg is preserved in all cases.
 * Opus encoding is handled downstream by @discordjs/voice via opusscript.
 */
export function createAudioStream(
  url: string,
  startSeconds = 0,
  filter: AudioFilter = "Normal"
): AudioStreamResult {
  const ytArgs: string[] = [
    ...BASE,
    "-f", "bestaudio/best",
    "--no-playlist",
    "-o", "-",
    "--quiet",
    "--no-warnings",
    ...YT_CLIENT,
  ];

  if (startSeconds > 0) {
    ytArgs.push(
      "--download-sections", `*${Math.floor(startSeconds)}-inf`,
      "--force-keyframes-at-cuts"
    );
  }

  ytArgs.push("--", url);

  const ytProc = spawn(YTDLP, ytArgs);

  ytProc.on("error", (err) => {
    logger.error({ err }, "yt-dlp process error");
    if (!ytProc.stdout.destroyed) ytProc.stdout.destroy(err);
  });

  ytProc.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) logger.warn({ msg }, "yt-dlp stderr");
  });

  ytProc.on("close", (code) => {
    if (code !== 0 && code !== null && !ytProc.stdout.destroyed) {
      ytProc.stdout.destroy(new Error(`yt-dlp exited with code ${code}`));
    }
  });

  // ── No filter: return yt-dlp stdout directly ─────────────────────────────
  if (filter === "Normal") {
    return { stream: ytProc.stdout, streamType: StreamType.Arbitrary };
  }

  // ── Filtered: pipe through ffmpeg, output raw s16le PCM ──────────────────
  const filterChain = FILTER_PRESETS[filter];
  const ffArgs = [
    "-i", "pipe:0",
    "-af", filterChain,
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1",
  ];

  const ffProc = spawn(FFMPEG, ffArgs, { stdio: ["pipe", "pipe", "pipe"] });

  // Suppress EPIPE on ffmpeg's stdin — this fires when yt-dlp is killed
  // while ffmpeg is still open, or vice-versa.
  ffProc.stdin.on("error", () => {});

  ytProc.stdout.pipe(ffProc.stdin);

  ytProc.on("error", (err) => {
    if (!ffProc.stdin.destroyed) ffProc.stdin.destroy(err);
  });

  ffProc.on("error", (err) => {
    logger.error({ err }, "ffmpeg filter process error");
    if (!ffProc.stdout.destroyed) ffProc.stdout.destroy(err);
  });

  ffProc.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    // Suppress the verbose ffmpeg startup banner; only log real warnings
    if (msg && msg.includes("Error") && !msg.startsWith("ffmpeg version")) {
      logger.warn({ msg }, "ffmpeg filter stderr");
    }
  });

  ffProc.on("close", (code) => {
    if (code !== 0 && code !== null && !ffProc.stdout.destroyed) {
      ffProc.stdout.destroy(new Error(`ffmpeg exited with code ${code}`));
    }
  });

  return { stream: ffProc.stdout, streamType: StreamType.Raw };
}
