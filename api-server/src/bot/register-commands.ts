/**
 * Run once to register slash commands with Discord:
 *   pnpm --filter @workspace/api-server run register-commands
 */
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import * as play from "./commands/play.js";
import * as skip from "./commands/skip.js";
import * as pause from "./commands/pause.js";
import * as stop from "./commands/stop.js";
import * as leave from "./commands/leave.js";
import * as queue from "./commands/queue.js";
import * as nowplaying from "./commands/nowplaying.js";
import * as search from "./commands/search.js";
import * as lyrics from "./commands/lyrics.js";

// Arabic alias for /play
const arPlay = new SlashCommandBuilder()
  .setName("ش")
  .setDescription("تشغيل أغنية من يوتيوب — نفس أمر play")
  .addStringOption((opt) =>
    opt.setName("url").setDescription("رابط يوتيوب").setRequired(true)
  );

const token = process.env["DISCORD_TOKEN"];
if (!token) {
  console.error("DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

const commands = [
  ...([play, skip, pause, stop, leave, queue, nowplaying, search, lyrics].map((c) => c.data.toJSON())),
  arPlay.toJSON(),
];

const rest = new REST().setToken(token);

async function main() {
  const me = (await rest.get(Routes.currentApplication())) as { id: string; name: string };
  console.log(`Registering ${commands.length} commands for app: ${me.name} (${me.id})`);
  await rest.put(Routes.applicationCommands(me.id), { body: commands });
  console.log("Commands registered globally. They may take up to 1 hour to propagate.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
