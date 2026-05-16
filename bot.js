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
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await initMemberCounter();
    await initTicketPanel();
});

// ================================================================
// TICKET PANEL — posts/updates the button embed in the ticket channel
// ================================================================
async function initTicketPanel() {
    if (!TICKET_CHANNEL_ID) return;
    try {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        const channel = guild.channels.cache.get(TICKET_CHANNEL_ID);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎫 Thunder Moggers Support')
            .setDescription('Need help or have an issue? Click the button below to open a private ticket.\nStaff will be with you as soon as possible.')
            .setFooter({ text: 'Only you and staff can see your ticket.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('open_ticket')
                .setLabel('🎫 Open a Ticket')
                .setStyle(ButtonStyle.Primary)
        );

        // Look for an existing panel message from the bot
        const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
        const existing = recent?.find(m => m.author.id === client.user.id && m.components?.length > 0);

        if (existing) {
            await existing.edit({ embeds: [embed], components: [row] }).catch(() => {});
        } else {
            await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
        }
        console.log('[Tickets] Panel ready in channel', TICKET_CHANNEL_ID);
    } catch (err) {
        console.error('Error initialising ticket panel:', err);
    }
}

// ================================================================
// BUTTON INTERACTIONS
// ================================================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    // ---- Open ticket button ----
    if (interaction.customId === 'open_ticket') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const result = await createTicket(interaction.guild, interaction.user);
            if (result.existing) {
                await interaction.editReply({ content: `You already have an open ticket: <#${result.existing.id}>` });
            } else {
                await interaction.editReply({ content: `✅ Your ticket has been created: <#${result.channel.id}>` });
            }
        } catch (err) {
            console.error('Error opening ticket via button:', err);
            await interaction.editReply({ content: '❌ Something went wrong creating your ticket.' });
        }
        return;
    }

    // ---- Close ticket button ----
    if (interaction.customId === 'close_ticket') {
        if (!interaction.channel.topic?.startsWith('Ticket for')) return;
        const ticketOwnerId = interaction.channel.topic.replace('Ticket for ', '');
        const isTicketOwner = interaction.user.id === ticketOwnerId;
        const isPrivileged = hasCommandPermission(interaction.member);

        if (!isTicketOwner && !isPrivileged) {
            await interaction.reply({ content: '❌ Only the ticket owner or staff can close this.', ephemeral: true });
            return;
        }

        await interaction.reply({ content: '🔒 Closing ticket in 5 seconds...' });
        await sendLog(`🎫 **Ticket closed** by @${interaction.user.username} → #${interaction.channel.name}`);
        setTimeout(() => interaction.channel.delete('Ticket closed').catch(() => {}), 5000);
    }
});

// ================================================================
// MEMBER JOIN
// ================================================================
client.on('guildMemberAdd', async (member) => {
    const guild = member.guild;

    // ---- GIVE UNVERIFIED ROLE ONLY ----
    if (UNVERIFIED_ROLE_ID) {
        const unverifiedRole = guild.roles.cache.get(UNVERIFIED_ROLE_ID);
        if (unverifiedRole) await member.roles.add(unverifiedRole).catch(() => {});
    } else {
        // Fallback: give all roles if no unverified role is configured
        try {
            const rolesToAdd = [MEMBER_ROLE_ID, ANNOUNCEMENTS_PING_ROLE_ID, CHAT_REVIVE_ROLE_ID].filter(Boolean);
            for (const roleId of rolesToAdd) {
                const role = guild.roles.cache.get(roleId);
                if (role) await member.roles.add(role).catch(() => {});
            }
        } catch (err) {
            console.error("Error adding auto-roles:", err);
        }
    }

    // ---- WELCOME MESSAGE ----
    if (WELCOME_CHANNEL_ID) {
        const channel = guild.channels.cache.get(WELCOME_CHANNEL_ID);
        if (channel) {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('YOOO WSP BRO WELCOME TO THUNDER MOGGERS😝')
                .setDescription(`Hey <@${member.id}>, glad you're here fam!`)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
                .addFields({ name: 'Username', value: `@${member.user.username}`, inline: true })
                .setFooter({ text: `Member #${guild.memberCount}` })
                .setTimestamp();
            await channel.send({ embeds: [embed] }).catch(() => {});
        }
    }

    // ---- VERIFY PROMPT ----
    if (VERIFY_CHANNEL_ID) {
        const verifyChannel = guild.channels.cache.get(VERIFY_CHANNEL_ID);
        if (verifyChannel) {
            await verifyChannel.send(`<@${member.id}> are u a robot gng😐`).catch(() => {});
        }
    }

    // ---- RAID DETECTION ----
    const now = Date.now();
    recentJoins.push({ id: member.id, time: now });
    while (recentJoins.length && now - recentJoins[0].time > RAID_TIME_FRAME) recentJoins.shift();

    if (recentJoins.length >= RAID_JOIN_LIMIT) {
        await sendLog(`🚨 **RAID DETECTED** — ${recentJoins.length} users joined in under ${RAID_TIME_FRAME / 1000}s. Banning raiders...`);
        for (const joiner of recentJoins) {
            const raider = guild.members.cache.get(joiner.id);
            if (raider && raider.bannable) {
                await raider.ban({ reason: 'Anti-raid: mass join detected', deleteMessageSeconds: NUKE_BAN_DURATION }).catch(() => {});
                scheduleUnban(guild, joiner.id, NUKE_BAN_DURATION);
            }
        }
        recentJoins.length = 0;
    }
});

// ================================================================
// MEMBER LEAVE
// ================================================================
client.on('guildMemberRemove', async (member) => {
    if (!GOODBYE_CHANNEL_ID) return;
    const channel = member.guild.channels.cache.get(GOODBYE_CHANNEL_ID);
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('Goodbye bro.. Thanks for being with us😥')
        .setDescription(`@${member.user.username} has left the server.`)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(() => {});
});

// ================================================================
// MESSAGE HANDLING
// ================================================================
client.on('messageCreate', async (message) => {
    if (!message.guild) return;
    if (message.author.bot) return;

    const isPrivileged = hasCommandPermission(message.member);

    // ---- VERIFY SYSTEM ----
    if (VERIFY_CHANNEL_ID && message.channel.id === VERIFY_CHANNEL_ID) {
        const noResponses = /\b(no|nah|nope|im not|i'm not|not a robot|not a bot|nop)\b/i;
        if (noResponses.test(message.content)) {
            await message.reply('Ohh mb bro').catch(() => {});

            // Remove Unverified role, add Member + other roles
            try {
                if (UNVERIFIED_ROLE_ID) {
                    const unverifiedRole = message.guild.roles.cache.get(UNVERIFIED_ROLE_ID);
                    if (unverifiedRole) await message.member.roles.remove(unverifiedRole).catch(() => {});
                }
                const rolesToAdd = [MEMBER_ROLE_ID, ANNOUNCEMENTS_PING_ROLE_ID, CHAT_REVIVE_ROLE_ID].filter(Boolean);
                for (const roleId of rolesToAdd) {
                    const role = message.guild.roles.cache.get(roleId);
                    if (role) await message.member.roles.add(role).catch(() => {});
                }
            } catch (err) {
                console.error("Error assigning verified roles:", err);
            }
        }
        return;
    }

    // ---- AI PFP MAKER ----
    if (AI_PFP_CHANNEL_ID && message.channel.id === AI_PFP_CHANNEL_ID) {
        const pfpTrigger = /^hey mogger[,.]?\s+(.+)/i;
        const match = message.content.match(pfpTrigger);
        if (match) {
            const userPrompt = match[1].trim();
            const thinking = await message.reply('🎨 Generating your pfp, give me a sec...').catch(() => null);
            try {
                // Use Pollinations text AI to expand the prompt into a detailed image description
                const aiTextUrl = `https://text.pollinations.ai/${encodeURIComponent(
                    `You are an expert image prompt engineer. Convert this request into a detailed, vivid image generation prompt for a square profile picture. Include art style, colors, lighting, and specific visual details. Be very specific about what the subject looks like. Request: "${userPrompt}". Reply with ONLY the image prompt, nothing else.`
                )}?model=openai&seed=${Math.floor(Math.random() * 999999)}`;

                let detailedPrompt = userPrompt;
                try {
                    const textBuffer = await fetchImageBuffer(aiTextUrl);
                    const aiText = textBuffer.toString('utf8').trim();
                    if (aiText && aiText.length > 10) detailedPrompt = aiText;
                    console.log(`[PFP] Expanded prompt: ${detailedPrompt}`);
                } catch (e) {
                    console.warn('[PFP] Text AI failed, using raw prompt');
                }

                const encodedPrompt = encodeURIComponent(
                    `profile picture, square format, ${detailedPrompt}, highly detailed, vibrant digital art`
                );
                const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true&model=flux&seed=${Date.now()}`;
                const buffer = await fetchImageBuffer(imageUrl);
                const attachment = new AttachmentBuilder(buffer, { name: 'pfp.png' });
                await message.channel.send({
                    content: `<@${message.author.id}> here's your pfp bro 🔥`,
                    files: [attachment]
                });
                if (thinking) await thinking.delete().catch(() => {});
            } catch (err) {
                console.error("Error generating pfp:", err);
                if (thinking) await thinking.edit('❌ Couldn\'t generate the pfp rn, try again.').catch(() => {});
            }
        }
        return;
    }

    // ---- Keep ticket channel clean (delete non-bot messages) ----
    if (TICKET_CHANNEL_ID && message.channel.id === TICKET_CHANNEL_ID) {
        await message.delete().catch(() => {});
        return;
    }

    // ================================================================
    // OWNER / CO-OWNER COMMANDS
    // ================================================================
    if (message.content.startsWith('!ban') || message.content.startsWith('!purge')) {
        if (!isPrivileged) {
            await message.reply('❌ You need the **Owner** or **Co owner** role to use this command.').catch(() => {});
            return;
        }

        // ---- !ban @user — ban + DM ----
        if (message.content.startsWith('!ban')) {
            const target = message.mentions.members.first();
            if (!target) {
                await message.reply('Please mention a user. Usage: `!ban @user`').catch(() => {});
                return;
            }
            try {
                await target.send(
                    `Sorry bro u broke the rules and have been banned from Thunder Moggers for now. Sorry. Have a good day tho` +
                    ` if u got falsely banned dm the owner of the server and bot owner his user is bright_guava_73352`
                ).catch(() => {});
                await target.ban({ reason: `Banned by ${message.author.username}` });
                await sendLog(`🔨 **Banned:** @${target.user.username} — by @${message.author.username}`);
                await message.reply(`✅ @${target.user.username} has been banned and notified.`).catch(() => {});
            } catch (err) {
                console.error("Error banning user:", err);
                await message.reply('❌ Failed to ban that user.').catch(() => {});
            }
            return;
        }

        // ---- !purge — delete all messages in channel ----
        if (message.content.startsWith('!purge')) {
            await message.delete().catch(() => {});
            const channel = message.channel;
            let deleted = 0;
            const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

            const notice = await channel.send('🗑️ Purging messages...').catch(() => null);

            try {
                let lastId = null;

                while (true) {
                    const options = { limit: 100 };
                    if (lastId) options.before = lastId;

                    const fetched = await channel.messages.fetch(options).catch(() => null);
                    if (!fetched || fetched.size === 0) break;

                    // Skip the notice message so we don't delete it mid-purge
                    const toDelete = fetched.filter(m => m.id !== notice?.id);
                    if (toDelete.size === 0) break;

                    lastId = toDelete.last().id;

                    // Split into bulk-deletable (< 14 days) and old messages
                    const bulkable = toDelete.filter(m => Date.now() - m.createdTimestamp < TWO_WEEKS);
                    const old      = toDelete.filter(m => Date.now() - m.createdTimestamp >= TWO_WEEKS);

                    if (bulkable.size > 0) {
                        const result = await channel.bulkDelete(bulkable, true).catch(() => null);
                        if (result) deleted += result.size;
                    }

                    // Delete old messages one by one
                    for (const [, msg] of old) {
                        const ok = await msg.delete().catch(() => null);
                        if (ok) deleted++;
                        await new Promise(r => setTimeout(r, 300)); // avoid rate limits
                    }

                    if (fetched.size < 100) break;
                }

                await sendLog(`🗑️ **Purge:** @${message.author.username} purged ${deleted} messages in #${channel.name}`);
                if (notice) {
                    await notice.edit(`✅ Purged **${deleted}** messages.`).catch(() => {});
                    setTimeout(() => notice.delete().catch(() => {}), 4000);
                }
            } catch (err) {
                console.error("Error purging channel:", err);
                if (notice) await notice.edit('❌ Something went wrong during purge.').catch(() => {});
            }
            return;
        }
    }

    if (isPrivileged) return;

    const userId = message.author.id;

    // ---- SELF-PROMO DETECTION ----
    if (SELF_PROMO_REGEX.test(message.content)) {
        try {
            await message.delete().catch(() => {});
            await message.member.timeout(SELF_PROMO_TIMEOUT, 'Self-promotion');
            await sendLog(`🚫 **Self-promo timeout (1h):** @${message.author.username}`);
        } catch (err) {
            console.error("Error handling self-promo:", err);
        }
        return;
    }

    // ---- SWEAR WORD DETECTION ----
    if (SWEAR_REGEX.test(message.content)) {
        const current = (swearCounts.get(userId) || 0) + 1;
        swearCounts.set(userId, current);
        await message.channel.send(
            `@${message.author.username} has said ${current} swear word${current === 1 ? '' : 's'} 🤬`
        ).catch(() => {});
    }

    // ---- SPAM TRACKING ----
    if (!userMessages.has(userId)) userMessages.set(userId, []);
    const timestamps = userMessages.get(userId);
    const now = Date.now();
    timestamps.push(now);
    while (timestamps.length && now - timestamps[0] > TIME_FRAME) timestamps.shift();

    if (timestamps.length >= MESSAGE_LIMIT) {
        await timeoutUser(message, "Spamming messages", TIMEOUT_DURATION);
        return;
    }

    // ---- MASS MENTION ----
    if (message.mentions.users.size > MAX_MENTIONS) {
        await timeoutUser(message, "Mass mentioning users", TIMEOUT_DURATION);
        return;
    }

    // ---- WEBHOOK DETECTION ----
    if (message.webhookId) {
        await timeoutUser(message, "Suspicious webhook activity", TIMEOUT_DURATION);
        return;
    }
});

// ================================================================
// ANTI-NUKE
// ================================================================
async function trackNukeAction(guild, userId, label) {
    if (!nukeActions.has(userId)) nukeActions.set(userId, []);
    const actions = nukeActions.get(userId);
    const now = Date.now();
    actions.push(now);
    while (actions.length && now - actions[0] > NUKE_TIME_FRAME) actions.shift();

    if (actions.length >= NUKE_ACTION_LIMIT) {
        nukeActions.delete(userId);
        const member = guild.members.cache.get(userId);
        if (member && member.bannable) {
            await member.ban({ reason: `Anti-nuke: ${label}`, deleteMessageSeconds: NUKE_BAN_DURATION }).catch(() => {});
            await sendLog(`🔨 **NUKE BAN:** @${member.user.username} — **Reason:** ${label}`);
            scheduleUnban(guild, userId, NUKE_BAN_DURATION);
        }
    }
}

client.on('channelDelete', async (channel) => {
    if (!channel.guild) return;
    try {
        const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 3000) {
            await trackNukeAction(channel.guild, entry.executor.id, 'Mass channel deletion');
        }
    } catch {}
});

client.on('roleDelete', async (role) => {
    if (!role.guild) return;
    try {
        const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 3000) {
            await trackNukeAction(role.guild, entry.executor.id, 'Mass role deletion');
        }
    } catch {}
});

client.on('guildBanAdd', async (ban) => {
    try {
        const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 });
        const entry = logs.entries.first();
        if (entry && Date.now() - entry.createdTimestamp < 3000 && entry.executor.id !== client.user.id) {
            await trackNukeAction(ban.guild, entry.executor.id, 'Mass banning members');
        }
    } catch {}
});

// ================================================================
// MEMBER COUNTER — edits same message, survives restarts
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
// LOGIN
// ================================================================
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error("ERROR: DISCORD_BOT_TOKEN is not set.");
    process.exit(1);
}

client.login(token);
