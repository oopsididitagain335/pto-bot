// bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const express = require('express');

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || null;

// Optional web server (for Render, Railway, etc.)
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
const PTO_REQUEST_CHANNEL_ID = '1405324971424612504'; // User submits PTO
const PTO_LOG_CHANNEL_ID = '1405326441511653471';     // Bot logs + memory
const PTO_END_ANNOUNCE_CHANNEL_ID = '1405333223768068137'; // PTO end pings

const MAX_CONCURRENT_PTO = 4;           // Max people on PTO at once
const ROLLING_WINDOW_DAYS = 60;         // Rolling window for PTO quota
const MAX_PTO_PER_WINDOW = 14.0;        // 14 days per 60 days

// Regex to parse: "Name - 5 days - Reason"
const PTO_REGEX = /^(.+?)\s*-\s*(\d+(?:\.\d+)?)\s*days?\s*-\s*(.+)$/i;

// Format date as Discord relative timestamp
function discordTimestamp(date) {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

// Format date for display
function formatTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

// Get total PTO used by user in the last 60 days (from request channel)
async function getUserPTOUsage(channel, userId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let total = 0;

  const messages = await channel.messages.fetch({ limit: 100 });
  const validMessages = messages.filter(m => 
    !m.author.bot && m.createdTimestamp >= cutoff.getTime()
  );

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

  return Math.round(total * 10) / 10; // 1 decimal
}

// Get list of users currently on PTO (end time in future)
async function getCurrentlyOnPTO(channel) {
  const now = new Date();
  const results = [];

  const messages = await channel.messages.fetch({ limit: 100 });
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

      if (userId) {
        results.push({
          userId,
          username: userPart.trim(),
          days: durationDays,
          reason: reason.trim(),
          startTime: requestTime,
          endTime,
          message: msg,
        });
      }
    }
  }

  return results.sort((a, b) => a.endTime - b.endTime);
}

// Post current PTO status to any channel
async function postCurrentPTOStatus(targetChannel) {
  try {
    const currentOnPTO = await getCurrentlyOnPTO(targetChannel);
    const totalOnPTO = currentOnPTO.length;

    let description = '';

    if (currentOnPTO.length === 0) {
      description = '📭 No one is currently on PTO.';
    } else {
      description = currentOnPTO.map(p => {
        const userTag = `<@${p.userId}>`;
        return `• ${userTag} (**${p.days}d**) – _${p.reason}_ ends ${discordTimestamp(p.endTime)}`;
      }).join('\n');
    }

    const statusEmbed = {
      title: `👥 Currently on PTO: ${totalOnPTO}/${MAX_CONCURRENT_PTO}`,
      description,
      color: totalOnPTO >= MAX_CONCURRENT_PTO ? 0xff0000 : totalOnPTO >= MAX_CONCURRENT_PTO - 1 ? 0xffaa00 : 0x00ff00,
      timestamp: new Date(),
      footer: { text: 'PTO Tracker' },
    };

    await targetChannel.send({ embeds: [statusEmbed] });
  } catch (err) {
    console.error('Failed to post current PTO status:', err);
  }
}

// Track scheduled timeouts (userId → timeout)
const scheduledTimeouts = new Map();

// Schedule alert when PTO ends
async function schedulePTOEndAlert(userId, days, messageTime, logChannel) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const announceChannel = client.channels.cache.get(PTO_END_ANNOUNCE_CHANNEL_ID);
  const requestTime = new Date(messageTime);
  const endTime = new Date(requestTime.getTime() + days * 24 * 60 * 60 * 1000);
  const now = new Date();

  if (endTime <= now) return;

  const delay = endTime - now;

  // Clear existing timeout
  if (scheduledTimeouts.has(userId)) {
    clearTimeout(scheduledTimeouts.get(userId));
    scheduledTimeouts.delete(userId);
  }

  const timeout = setTimeout(async () => {
    // Send DM
    await user.send({
      content: `⏰ Your PTO has ended! You were off for **${days} days**. Welcome back!`
    }).catch(() => {});

    // Announce in channel
    if (announceChannel) {
      await announceChannel.send({
        content: `<@${userId}> 🎉 **Welcome back!** Your PTO has ended. You were off for **${days} days**.`,
      });
    }

    // Log in PTO log channel
    if (logChannel) {
      await logChannel.send({
        embeds: [{
          title: '🔚 PTO Ended',
          description: `<@${userId}> has returned from **${days} days** of PTO.`,
          color: 0x777777,
          timestamp: new Date(),
        }]
      });
    }

    scheduledTimeouts.delete(userId);
  }, delay);

  scheduledTimeouts.set(userId, timeout);
}

// On ready
client.on('ready', () => {
  console.log(`✅ ${client.user.tag} is online.`);

  // Lock request channel
  const requestChannel = client.channels.cache.get(PTO_REQUEST_CHANNEL_ID);
  if (requestChannel) {
    requestChannel.permissionOverwrites.edit(requestChannel.guild.roles.everyone, {
      [PermissionFlagsBits.ManageMessages]: false,
      ViewChannel: true,
      SendMessages: true,
    }).catch(console.error);
    console.log('🔒 Request channel locked.');
  }

  // Restore active PTO alerts from log channel
  const logChannel = client.channels.cache.get(PTO_LOG_CHANNEL_ID);
  if (logChannel) {
    logChannel.messages.fetch({ limit: 100 }).then(messages => {
      const validMessages = messages.filter(m => !m.author.bot);
      for (const msg of validMessages.values()) {
        const match = PTO_REGEX.exec(msg.content);
        if (!match) continue;

        const mentionMatch = msg.content.match(/<@!?(\d+)>/);
        if (!mentionMatch) continue;

        const userId = mentionMatch[1];
        const days = parseFloat(match[2]);
        if (isNaN(days)) continue;

        const requestTime = msg.createdTimestamp;
        schedulePTOEndAlert(userId, days, requestTime, logChannel);
      }
    }).catch(console.error);
  }
});

// On message
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Handle ,pto command
  if (message.content.trim() === ',pto') {
    await postCurrentPTOStatus(message.channel);
    return;
  }

  // Only process in request channel
  if (message.channel.id !== PTO_REQUEST_CHANNEL_ID) return;

  const match = PTO_REGEX.exec(message.content);
  if (!match) {
    const warning = await message.reply({
      content: '❌ **Invalid format.** Use: `Your Name - X days - Reason`',
    });
    setTimeout(() => warning.delete().catch(() => {}), 10000);
    return;
  }

  const [, userPart, daysStr, reason] = match;
  const requestedDays = Math.round(parseFloat(daysStr) * 10) / 10;

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
      content: "⚠️ You can only submit PTO for yourself.",
    });
    return;
  }

  const requestChannel = message.channel;
  const logChannel = client.channels.cache.get(PTO_LOG_CHANNEL_ID);
  if (!logChannel) return;

  // 1. Check 60-day quota
  const usedPTO = await getUserPTOUsage(requestChannel, userId);
  const remaining = MAX_PTO_PER_WINDOW - usedPTO;

  if (requestedDays > remaining) {
    await message.reply({
      content: `❌ **Denied:** Used ${usedPTO.toFixed(1)}/14 days. Only ${remaining.toFixed(1)} days left.`,
    });
    return;
  }

  // 2. Check concurrent limit
  const currentOnPTO = await getCurrentlyOnPTO(requestChannel);
  if (currentOnPTO.length >= MAX_CONCURRENT_PTO) {
    await message.reply({
      content: `🚫 Max ${MAX_CONCURRENT_PTO} people on PTO. Wait for someone to return.`,
    });
    return;
  }

  // ✅ APPROVED
  const userMention = `<@${userId}>`;
  await message.reply({
    content: `✅ **Approved:** ${userMention} requested **${requestedDays} days** off for _${reason.trim()}_`,
  });

  // Log to log channel
  await logChannel.send({
    embeds: [{
      title: '✅ PTO Approved',
      description: `${userMention} is off for **${requestedDays} days**\n> _${reason.trim()}_`,
      fields: [
        { name: 'Used (60d)', value: `${(usedPTO + requestedDays).toFixed(1)}/${MAX_PTO_PER_WINDOW}`, inline: true },
        { name: 'Ends', value: discordTimestamp(new Date(message.createdTimestamp + requestedDays * 24 * 60 * 60 * 1000)), inline: true },
      ],
      color: 0x00ff00,
      timestamp: new Date(),
    }]
  });

  // Schedule end alert
  schedulePTOEndAlert(userId, requestedDays, message.createdTimestamp, logChannel);

  // Update status
  await postCurrentPTOStatus(logChannel);
});

// Login
client.login(TOKEN).catch(err => {
  console.error('❌ Failed to log in. Check your token.');
  console.error(err);
});
