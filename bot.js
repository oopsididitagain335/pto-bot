// bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const express = require('express');

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || null;

// Optional web server (for hosting platforms like Render/Railway)
if (PORT) {
  const app = express();
  app.get('/', (req, res) => res.send('PTO Bot is running.'));
  app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
}

// Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Channel IDs
const PTO_REQUEST_CHANNEL_ID = '1405324971424612504'; // Where users send requests
const PTO_LOG_CHANNEL_ID = '1405326441511653471';     // Bot logs and current PTO status

const MAX_CONCURRENT_PTO = 4; // Max people on PTO at the same time
const ROLLING_WINDOW_DAYS = 60;
const MAX_PTO_PER_WINDOW = 14.0; // 14 days every 60 days

// Regex to parse: "Name - 5 days - Reason"
const PTO_REGEX = /^(.+?)\s*-\s*(\d+(?:\.\d+)?)\s*days?\s*-\s*(.+)$/i;

// Get total PTO used by user in the last 60 days
async function getUserPTOUsage(channel, userId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let total = 0;

  const messages = await channel.messages.fetch({ limit: 200 });
  const validMessages = messages.filter(m => !m.author.bot && m.createdTimestamp >= cutoff);

  for (const msg of validMessages.values()) {
    const match = PTO_REGEX.exec(msg.content);
    if (!match) continue;

    let parsedUserId = null;
    const mentionMatch = msg.content.match(/<@!?(\d+)>/);
    if (mentionMatch) {
      parsedUserId = mentionMatch[1];
    } else {
      const inputName = match[1].trim().toLowerCase();
      const member = msg.guild.members.cache.find(m =>
        m.displayName.toLowerCase() === inputName ||
        m.user.username.toLowerCase() === inputName ||
        m.user.tag.toLowerCase().startsWith(inputName)
      );
      if (member) parsedUserId = member.id;
    }

    if (parsedUserId === userId) {
      const days = parseFloat(match[2]);
      if (!isNaN(days)) total += days;
    }
  }

  return Math.round(total * 10) / 10;
}

// Get list of users currently on PTO (end time in future)
async function getCurrentlyOnPTO(channel) {
  const now = new Date();
  const results = [];

  const messages = await channel.messages.fetch({ limit: 200 });
  const validMessages = messages.filter(m => !m.author.bot);

  for (const msg of validMessages.values()) {
    const match = PTO_REGEX.exec(msg.content);
    if (!match) continue;

    const [, userPart, daysStr, reason] = match;
    const durationDays = parseFloat(daysStr);
    if (isNaN(durationDays)) continue;

    const requestTime = new Date(msg.createdTimestamp);
    const endTime = new Date(requestTime.getTime() + durationDays * 24 * 60 * 60 * 1000);

    if (endTime > now) {
      let userId = null;
      const mentionMatch = msg.content.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        userId = mentionMatch[1];
      } else {
        const member = msg.guild.members.cache.find(m =>
          m.displayName.toLowerCase() === userPart.trim().toLowerCase() ||
          m.user.username.toLowerCase() === userPart.trim().toLowerCase()
        );
        if (member) userId = member.id;
      }

      results.push({
        userId,
        username: userPart.trim(),
        days: durationDays,
        reason: reason.trim(),
        endTime,
        message: msg,
      });
    }
  }

  return results;
}

// Format date nicely
function formatTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

// Post current PTO status to log channel
async function postCurrentPTOStatus(logChannel) {
  try {
    const currentOnPTO = await getCurrentlyOnPTO(logChannel);
    const totalOnPTO = currentOnPTO.length;

    let description = '';

    if (currentOnPTO.length === 0) {
      description = '📭 No one is currently on PTO.';
    } else {
      description = currentOnPTO.map(p => {
        const userTag = p.userId ? `<@${p.userId}>` : p.username;
        return `• ${userTag} (**${p.days} days**) – _${p.reason}_ (ends ${formatTime(p.endTime)})`;
      }).join('\n');
    }

    const statusEmbed = {
      title: `👥 Currently on PTO: ${totalOnPTO}/${MAX_CONCURRENT_PTO}`,
      description,
      color: totalOnPTO >= MAX_CONCURRENT_PTO ? 0xff0000 : totalOnPTO >= MAX_CONCURRENT_PTO - 1 ? 0xffaa00 : 0x00ff00,
      timestamp: new Date(),
      footer: { text: 'PTO Status' },
    };

    await logChannel.send({ embeds: [statusEmbed] });
  } catch (err) {
    console.error('Failed to post current PTO status:', err);
  }
}

// On ready
client.on('ready', () => {
  console.log(`✅ ${client.user.tag} is online.`);

  // Lock request channel: no one can delete messages
  const requestChannel = client.channels.cache.get(PTO_REQUEST_CHANNEL_ID);
  if (requestChannel) {
    requestChannel.permissionOverwrites.edit(requestChannel.guild.roles.everyone, {
      [PermissionFlagsBits.ManageMessages]: false,
      ViewChannel: true,
      SendMessages: true,
    }).catch(console.error);

    console.log('🔒 Request channel locked: No one can delete messages.');
  }

  // Post initial PTO status on startup
  const logChannel = client.channels.cache.get(PTO_LOG_CHANNEL_ID);
  if (logChannel) {
    postCurrentPTOStatus(logChannel).catch(console.error);
  } else {
    console.warn('⚠️ Log channel not found on startup.');
  }
});

// On message
client.on('messageCreate', async (message) => {
  if (message.channel.id !== PTO_REQUEST_CHANNEL_ID) return;
  if (message.author.bot) return;

  const match = PTO_REGEX.exec(message.content);
  if (!match) {
    const warning = await message.reply({
      content: '❌ **Invalid format.** Use: `Your Name - X days - Reason`',
    });
    setTimeout(() => warning.delete().catch(() => {}), 10000);
    return;
  }

  const [, userPart, daysStr, reason] = match;
  const requestedDays = parseFloat(daysStr);

  if (isNaN(requestedDays) || requestedDays <= 0) {
    await message.reply({ content: '❌ Invalid number of days.' });
    return;
  }

  // Resolve user ID
  let userId = null;
  const mentionMatch = message.content.match(/<@!?(\d+)>/);
  if (mentionMatch) {
    userId = mentionMatch[1];
  } else {
    const displayName = message.member?.displayName?.toLowerCase();
    const username = message.author.username.toLowerCase();
    const tag = message.author.tag.toLowerCase();
    const inputName = userPart.trim().toLowerCase();

    if (
      inputName === displayName ||
      inputName === username ||
      tag.startsWith(inputName)
    ) {
      userId = message.author.id;
    }
  }

  if (!userId || userId !== message.author.id) {
    await message.reply({
      content: "⚠️ You can only submit PTO for yourself. Use your @mention or your exact name.",
    });
    return;
  }

  const requestChannel = message.channel;
  const logChannel = client.channels.cache.get(PTO_LOG_CHANNEL_ID);

  if (!logChannel) {
    console.error('❌ Log channel not accessible.');
    return;
  }

  // 1. Check 60-day quota
  const usedPTO = await getUserPTOUsage(requestChannel, userId);
  const remainingQuota = MAX_PTO_PER_WINDOW - usedPTO;

  if (requestedDays > remainingQuota) {
    const denialMsg = `❌ **Denied:** You've used **${usedPTO.toFixed(1)}/${MAX_PTO_PER_WINDOW}** days in the last ${ROLLING_WINDOW_DAYS} days.\nRequested: **${requestedDays}**, but only **${remainingQuota.toFixed(1)}** days remaining.`;
    await message.reply({ content: denialMsg });
    return;
  }

  // 2. Check concurrent PTO limit
  const currentOnPTO = await getCurrentlyOnPTO(requestChannel);
  const totalOnPTO = currentOnPTO.length;

  if (totalOnPTO >= MAX_CONCURRENT_PTO) {
    const denialMsg = `🚫 **Slot Full:** ${MAX_CONCURRENT_PTO} people are already on PTO. Wait for someone to return.`;
    await message.reply({ content: denialMsg });
    return;
  }

  // ✅ APPROVED
  const userMention = `<@${userId}>`;
  const approvalMsg = `✅ **Approved:** ${userMention} requested **${requestedDays} days** off for _${reason.trim()}_`;

  await message.reply({ content: approvalMsg });

  // Log to log channel
  const logEmbed = {
    title: '✅ PTO Approved',
    description: `${userMention} is off for **${requestedDays} days**\n> _${reason.trim()}_`,
    fields: [
      { name: 'Used (60d)', value: `${(usedPTO + requestedDays).toFixed(1)}/${MAX_PTO_PER_WINDOW}`, inline: true },
      { name: 'Ends', value: formatTime(new Date(Date.now() + requestedDays * 24 * 60 * 60 * 1000)), inline: true },
    ],
    color: 0x00ff00,
    timestamp: new Date(),
  };

  await logChannel.send({ embeds: [logEmbed] });

  // Update current PTO status
  await postCurrentPTOStatus(logChannel);
});

// Login
client.login(TOKEN).catch(err => {
  console.error('❌ Failed to log in. Check your token.');
  console.error(err);
});
