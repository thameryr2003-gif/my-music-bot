// ─── Runtime patch: extend DisTube's hardcoded 30s voice timeout to 120s ─────// -- Runtime patch: extend DisTube's hardcoded 30s voice timeout to 120s
// // Must run BEFORE require('distube') so the module loads with the patched value.
const fs = require('fs');
const path = require('path');
const _distubeDist = path.join(__dirname, 'node_modules', 'distube', 'dist', 'index.js');
try {
    let _src = fs.readFileSync(_distubeDist, 'utf8');
    if (_src.includes('var JOIN_TIMEOUT_MS = 3e4;')) {
        fs.writeFileSync(_distubeDist, _src.replace('var JOIN_TIMEOUT_MS = 3e4;', 'var JOIN_TIMEOUT_MS = 12e4;'));
        console.log('✅ Voice timeout patched: 30s -> 120s');
    } else {
        console.log('ℹ️ Voice timeout already patched or not found - skipping.');
    }
} catch (patchErr) {
    console.warn('⚠️ Timeout patch skipped:', patchErr.message);
}
// //

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { DisTube } = require('distube');
const { YouTubePlugin } = require('@distube/youtube');

// تم مسح التوكن الأصلي وربطه بالنظام للحماية
const TOKEN             = process.env.DISCORD_BOT_TOKEN || 'YOUR_DISCORD_BOT_TOKEN';
const TEXT_CHANNEL_ID   = '1460598644699955311';
const VOICE_CHANNEL_ID  = '1460598644699955311';
const PREFIX            = 'ش';

let isPlaying = false;

// -- Client

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
    ws: {
        properties: {
            browser: 'Discord Android',
            os: 'Android',
            device: 'Discord Android',
        },
    },
});

// -- DisTube

const distube = new NewDisTube(client, {
    plugins: [new YouTubePlugin()],
    emitNewSongOnly: true,
    joinNewVoiceChannel: true,
});

// -- Helpers

async function fetchVoiceChannel() {
    try {
        const ch = await client.channels.fetch(VOICE_CHANNEL_ID);
        return ch?.isVoiceBased() ? ch : null;
    } catch {
        return null;
    }
}

async function rejoinVoice() {
    const vc = await fetchVoiceChannel();
    if (!vc) return;
    try {
        await distube.voices.join(vc);
        console.log('✅ [Watchdog] Rejoined voice channel:', vc.name);
    } catch (err) {
        console.error('[Watchdog Rejoin Error]', err.message);
    }
}

// -- Ready

client.on(Events.ClientReady, () => {
    console.log(`✅ Bot online as: ${client.user.tag}`);
    console.log(`🔒 Text channel lock : ${TEXT_CHANNEL_ID}`);
    console.log(`🔊 Voice channel      : ${VOICE_CHANNEL_ID}`);
    console.log(`🎵 Prefix             : "${PREFIX}"`);
    client.user.setActivity('🎵 | ش اغانى', { type: 3 });

    // // Watchdog - reconnects only while a song is actively playing
    setInterval(async () => {
        if (!isPlaying) return;
        const vc = await fetchVoiceChannel();
        if (!vc) return;
        if (!distube.voices.has(vc.guild.id)) {
            console.log('🔍 Watchdog: voice lost - reconnecting...');
            await rejoinVoice();
        }
    }, 90_000);
});

// -- Message handler

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.channel.id !== TEXT_CHANNEL_ID) return; // // hard channel lock

    const content = message.content.trim();
    if (!content.startsWith(PREFIX)) return;

    const raw = content.slice(PREFIX.length).trim();
    const lower = raw.toLowerCase();

    if (lower === 'skip' || lower === 'تخطي') return handleSkip(message);
    if (lower === 'pause' || lower === 'توقف') return handlePause(message);
    if (lower === 'resume' || lower === 'استمر') return handleResume(message);
    if (['stop', 'leave', 'وقف', 'اوقف', 'خروج'].includes(lower)) return handleStop(message);
    if (raw.length > 0) return handlePlay(message, raw);
});

// -- Commands

async function handlePlay(message, query) {
    const vc = await fetchVoiceChannel();
    if (!vc) return message.reply('❌ القناة الصوتية غير موجودة.');

    const perms = vc.permissionsFor(message.guild.members.me);
    if (!perms?.has('Connect') || !perms?.has('Speak')) {
        return message.reply('❌ ليس لدي صلاحية الانضمام أو التحدث في القناة الصوتية.');
    }

    try {
        await message.react('🔍');
        console.log(`[Play] Searching: "${query}" - voice handshake window: 120s`);
        await distube.play(vc, query, {
            message,
            textChannel: message.channel,
            member: message.member,
        });
    } catch (err) {
        console.error('[Play Error]', err);
        if (err.errorCode === 'VOICE_CONNECT_FAILED') {
            return message.reply(
                `❌ **تعذر الاتصال بالقناة الصوتية بعد 120 ثانية**\n` +
                `المطلوب لصوت ديسكورد UDP السبب الأرجح: جدار حماية المضيف يحجب بروتوكول\n` +
                `على المنافذ 50000-65535 للحاوية UDP وطلب فتح WispBytes يرجى التواصل مع دعم`
            );
        }
        message.reply(`❌ حدث خطأ: \`${err.message}\``);
    }
}

async function handleSkip(message) {
    const queue = distube.getQueue(message.guild.id);
    if (!queue) return message.reply('❌ لا توجد أغنية تعزف حالياً.');
    if (queue.songs.length <= 1) {
        await distube.stop(message.guild.id);
        return message.reply('⏹️ لا توجد أغنية تالية - تم إيقاف التشغيل.');
    }
    try {
        await queue.skip();
        message.reply('⏭️ تم تخطي الأغنية الحالية.');
    } catch (err) {
        console.error('[Skip Error]', err);
        message.reply(`❌ خطأ في التخطي: \`${err.message}\``);
    }
}

async function handleStop(message) {
    const queue = distube.getQueue(message.guild.id);
    if (!queue) return message.reply('❌ لا توجد أغنية تعزف حالياً.');
    try {
        await distube.stop(message.guild.id);
        isPlaying = false;
        message.reply('⏹️ تم إيقاف الأغنية مؤقتاً.');
    } catch (err) {
        console.error('[Stop Error]', err);
        message.reply(`❌ خطأ: \`${err.message}\``);
    }
}

async function handlePause(message) {
    const queue = distube.getQueue(message.guild.id);
    if (!queue) return message.reply('❌ لا توجد أغنية تعزف حالياً.');
    try {
        queue.pause();
        message.reply('⏸️ تم إيقاف الأغنية مؤقتاً.');
    } catch (err) {
        console.error('[Pause Error]', err);
        message.reply(`❌ خطأ: \`${err.message}\``);
    }
}

async function handleResume(message) {
    const queue = distube.getQueue(message.guild.id);
    if (!queue || !queue.paused) return message.reply('❌ لا توجد أغنية متوقفة لاستئنافها.');
    try {
        queue.resume();
        message.reply('▶️ تم استئناف التشغيل.');
    } catch (err) {
        console.error('[Resume Error]', err);
        message.reply(`❌ خطأ: \`${err.message}\``);
    }
}

// -- DisTube events

distube.on('playSong', (queue, song) => {
    isPlaying = true;
    queue.textChannel?.send(
        `🎶 **الآن يعزف:** [${song.name}](${song.url})\n` +
        `⏱️ **المدة:** \`${song.formattedDuration}\` | 👤 **طلب من:** ${song.user}`
    );
});

distube.on('addSong', (queue, song) => {
    queue.textChannel?.send(
        `➕ **أضيفت إلى القائمة:** [${song.name}](${song.url})\n` +
        `🔢 **موقعها:** #\`${queue.songs.length}\``
    );
});

distube.on('finish', (queue) => {
    isPlaying = false;
    queue.textChannel?.send('⏹️ انتهت قائمة التشغيل.');
});

distube.on('disconnect', async (queue) => {
    if (isPlaying) {
        queue.textChannel?.send('⚠️ انقطع الاتصال - جاري إعادة الاتصال...');
        await rejoinVoice();
    }
});

distube.on('error', (channel, err) => {
    console.error('[DisTube Error]', err);
    channel?.send(`❌ حدث خطأ: \`${err.message}\``);
});

// -- Global guard

process.on('unhandledRejection', (err) => {
    console.error('[Unhandled Rejection]', err);
});

client.login(TOKEN);
