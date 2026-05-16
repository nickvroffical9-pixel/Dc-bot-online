// ================================================================
// 🌐 EXPRESS WEB SERVER FOR RENDER (KEEPS BOT ONLINE FOR FREE)
// ================================================================
const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot web server is running and healthy!');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// ================================================================
// 🤖 YOUR DISCORD BOT CODE BEGINS HERE
// ================================================================
const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    WebhookClient,
    EmbedBuilder,
    AuditLogEvent,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType
} = require('discord.js');
const https = require('https');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
    ]
});

// ---- SETTINGS ----
const MESSAGE_LIMIT       = 10;
const TIME_FRAME          = 4000;               // 4 seconds
const TIMEOUT_DURATION    = 5 * 60 * 60 * 1000; // 5 hours
const MAX_MENTIONS        = 3;
const SELF_PROMO_TIMEOUT  = 60 * 60 * 1000;     // 1 hour
const NUKE_BAN_DURATION   = 7 * 24 * 60 * 60;   // 7 days in seconds
const RAID_JOIN_LIMIT     = 5;
const RAID_TIME_FRAME     = 8000;               // 8 seconds
const NUKE_ACTION_LIMIT   = 3;
const NUKE_TIME_FRAME     = 8000;               // 8 seconds

// ---- ENV ----
const WELCOME_CHANNEL_ID         = process.env.WELCOME_CHANNEL_ID;
const GOODBYE_CHANNEL_ID         = process.env.GOODBYE_CHANNEL_ID;
const MEMBER_COUNTER_CHANNEL_ID  = process.env.MEMBER_COUNTER_CHANNEL_ID;
const VERIFY_CHANNEL_ID          = process.env.VERIFY_CHANNEL_ID;
const MEMBER_ROLE_ID             = process.env.MEMBER_ROLE_ID;
const ANNOUNCEMENTS_PING_ROLE_ID = process.env.ANNOUNCEMENTS_PING_ROLE_ID;
const CHAT_REVIVE_ROLE_ID        = process.env.CHAT_REVIVE_ROLE_ID;
const UNVERIFIED_ROLE_ID         = process.env.UNVERIFIED_ROLE_ID;
const AI_PFP_CHANNEL_ID          = process.env.AI_PFP_CHANNEL_ID;
const TICKET_CHANNEL_ID          = process.env.TICKET_CHANNEL_ID;
const TICKET_CATEGORY_ID         = process.env.TICKET_CATEGORY_ID;

const logsWebhook = process.env.DISCORD_LOGS_WEBHOOK_URL
    ? new WebhookClient({ url: process.env.DISCORD_LOGS_WEBHOOK_URL })
    : null;

// ---- STATE ----
const userMessages   = new Map();
const recentJoins    = [];
const nukeActions    = new Map();
const swearCounts    = new Map();
let memberCounterMsgId = null;

// ---- SWEAR WORD LIST ----
const SWEAR_WORDS = [
    'fuck', 'shit', 'ass', 'bitch', 'bastard', 'cunt', 'dick',
    'pussy', 'cock', 'damn', 'hell', 'piss', 'crap', 'whore',
    'slut', 'nigga', 'nigger', 'fag', 'faggot', 'retard', 'motherfucker'
];
const SWEAR_REGEX = new RegExp(`\\b(${SWEAR_WORDS.join('|')})\\b`, 'i');

// ---- SELF PROMO REGEX ----
const SELF_PROMO_REGEX = /(discord\.gg\/|discord\.com\/invite\/|twitch\.tv\/|youtube\.com\/|youtu\.be\/|instagram\.com\/|tiktok\.com\/)/i;

// ---- COMMAND PERMISSION CHECK ----
function hasCommandPermission(member) {
    if (!member) return false;
    // Server owner always has access
    if (member.guild.ownerId === member.id) return true;
    // Administrator permission always has access
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    // Owner or Co owner role
    return member.roles.cache.some(r =>
        r.name.toLowerCase() === 'owner' || r.name.toLowerCase() === 'co owner'
    );
}

// ---- HELPERS ----
async function sendLog(content) {
    console.log(`[LOG] ${content}`);
    if (logsWebhook) {
        try {
            await logsWebhook.send({ content });
        } catch (err) {
            console.error("Error sending webhook log:", err);
        }
    }
}

async function timeoutUser(message, reason, duration) {
    try {
        const member = message.member;
        if (!member || !member.moderatable) return;
        await member.timeout(duration, reason);
        await sendLog(`🔇 **Timed out:** @${member.user.username} — **Reason:** ${reason}`);
    } catch (err) {
        console.error("Error timing out user:", err);
    }
}

function scheduleUnban(guild, userId, durationSeconds) {
    setTimeout(async () => {
        await guild.members.unban(userId, 'Temporary ban expired').catch(() => {});
        await sendLog(`✅ **Unbanned:** <@${userId}> — ban duration expired`);
    }, durationSeconds * 1000);
}

// Download image buffer from URL
function fetchImageBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// ================================================================
// SHARED TICKET CREATION
// ================================================================
async function createTicket(guild, user) {
    // Check if user already has an open ticket
    const existing = guild.channels.cache.find(
        c => c.topic === `Ticket for ${user.id}`
    );
    if (existing) return { existing };

    const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
    const ticketChannel = await guild.channels.create({
        name: `ticket-${safeName}`,
        type: ChannelType.GuildText,
        topic: `Ticket for ${user.id}`,
        parent: TICKET_CATEGORY_ID || null,
        permissionOverwrites: [
            { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
            ...guild.roles.cache
                .filter(r => r.name.toLowerCase() === 'owner' || r.name.toLowerCase() === 'co owner')
                .map(r => ({ id: r.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] })),
            { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] },
        ]
    });

    const ownerRoles = guild.roles.cache.filter(r => r.name.toLowerCase() === 'owner' || r.name.toLowerCase() === 'co owner');
    const pings = ownerRoles.map(r => `<@&${r.id}>`).join(' ');

    const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('close_ticket')
            .setLabel('🔒 Close Ticket')
            .setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎫 Ticket Opened')
        .setDescription(`Hey <@${user.id}>, staff will be with you soon!\nDescribe your issue below.`)
        .setFooter({ text: 'Click the button below to close this ticket when done.' })
        .setTimestamp();

    await ticketChannel.send({ content: pings, embeds: [embed], components: [closeRow] });
    await sendLog(`🎫 **Ticket opened** by @${user.username} → <#${ticketChannel.id}>`);
    return { channel: ticketChannel };
}

// ================================================================
// READY
// ================================================================
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await initMemberCounter();
});

// ================================================================
// MEMBER COUNTER LOGIC
// ================================================================
async function initMemberCounter() {
    if (!MEMBER_COUNTER_CHANNEL_ID) return;
    try {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        const channel = guild.channels.cache.get(MEMBER_COUNTER_CHANNEL_ID);
        if (!channel) return;

        // Find the bot's existing counter message
        const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
        if (recent) {
            const existing = recent.find(m => m.author.id === client.user.id && m.content.includes('Members in Thunder Moggers'));
            if (existing) memberCounterMsgId = existing.id;
        }
    } catch (err) {
        console.error("Member counter init error:", err);
    }

    startMemberCounter();
}

function startMemberCounter() {
    if (!MEMBER_COUNTER_CHANNEL_ID) return;

    const updateCounter = async () => {
        try {
            const guild = client.guilds.cache.first();
            if (!guild) return;
            const channel = guild.channels.cache.get(MEMBER_COUNTER_CHANNEL_ID);
            if (!channel) return;

            const text = `👥 **Members in Thunder Moggers:** ${guild.memberCount}`;

            if (memberCounterMsgId) {
                const msg = await channel.messages.fetch(memberCounterMsgId).catch(() => null);
                if (msg) {
                    await msg.edit(text).catch(() => {});
                    return;
                }
            }

            // Only send a new message if none found
            const sent = await channel.send(text).catch(() => null);
            if (sent) memberCounterMsgId = sent.id;
        } catch (err) {
            console.error("Member counter error:", err);
        }
    };

    updateCounter();
    setInterval(updateCounter, 10000);
}

// ================================================================
// LOGIN EXECUTION
// ================================================================
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error("ERROR: DISCORD_BOT_TOKEN environment variable is missing!");
    process.exit(1);
}

client.login(token);

    
