// bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const express = require('express');

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || null;

// Optional web server for hosting platforms
if (PORT) {
  const app = express();
  app.get('/', (req, res) => res.send('PTO Bot is running!'));
  app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
}

// Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PTO_CHANNEL_ID = '1405324971424612504'; // Make sure this is a string

// Regex to parse: "username - 5 days - vacation"
const PTO_REGEX = /^(.+?)\s*-\s*(\d+(?:\.\d+)?)\s*days?\s*-\s*(.+)$/i;

// Max PTO allowed in 60-day rolling window
function getAllowedPTO() {
  return 14.0;
}

// Get used PTO for a user in the last 60 days
async function getUsedPTO(channel, userId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
  let total = 0;

  let fetched = await channel.messages.fetch({ limit: 100 });
  let messages = fetched.filter(m => m.author.bot === false && m.createdTimestamp >= cutoff);

  messages.forEach(msg => {
    if (msg.author.bot) return;

    const match = PTO_REGEX.exec(msg.content);
    if (!match) return;

    // Extract user identifier — use ID if possible, fallback to username
    let parsedUserId = null;
    const mentionMatch = msg.content.match(/<@!?(\d+)>/);
    if (mentionMatch) {
      parsedUserId = mentionMatch[1];
    } else {
      // Fallback: compare username (less reliable)
      const usernamePart = match[1].trim();
      if (usernamePart === msg.author.username || usernamePart === msg.author.displayName || usernamePart === msg.author.tag) {
        parsedUserId = msg.author.id;
      }
    }

    if (parsedUserId === userId) {
      const days = parseFloat(match[2]);
      if (!isNaN(days)) total += days;
    }
  });

  return Math.round(total * 10) / 10; // Round to 1 decimal
}

// On bot ready
client.on('ready', () => {
  console.log(`✅ ${client.user.tag} is online.`);

  // Optional: Lock down the PTO channel on startup (ensure no one can delete)
  const channel = client.channels.cache.get(PTO_CHANNEL_ID);
  if (channel) {
    channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      [PermissionFlagsBits.ManageMessages]: false,
      [PermissionFlagsBits.ViewChannel]: true,
      [PermissionFlagsBits.SendMessages]: true,
    }).catch(console.error);

    console.log('🔒 PTO channel permissions set: No one can delete messages.');
  }
});

// Listen to messages
client.on('messageCreate', async (message) => {
  // Only in PTO channel
  if (message.channel.id !== PTO_CHANNEL_ID) return;

  // Ignore bots
  if (message.author.bot) return;

  // Try to parse message
  const match = PTO_REGEX.exec(message.content);
  if (!match) {
    const warning = await message.reply({
      content: '❌ **Invalid format.** Use: `Your Name - X days - Reason`',
    });
    setTimeout(() => warning.delete().catch(() => {}), 10000);
    return;
  }

  const [_, userPart, daysStr, reason] = match;
  const requestedDays = parseFloat(daysStr);

  if (isNaN(requestedDays) || requestedDays <= 0) {
    await message.reply({ content: '❌ Invalid number of days.' });
    return;
  }

  // Resolve user ID
  let userId = null;
  const mention = message.content.match(/<@!?(\d+)>/);
  if (mention) {
    userId = mention[1];
  } else {
    // Fallback: assume it's the sender if name matches loosely
    const lowerUserPart = userPart.trim().toLowerCase();
    const displayName = message.member?.displayName?.toLowerCase();
    const username = message.author.username.toLowerCase();
    const tag = message.author.tag.toLowerCase();

    if (
      lowerUserPart === displayName ||
      lowerUserPart === username ||
      tag.startsWith(lowerUserPart)
    ) {
      userId = message.author.id;
    }
  }

  if (!userId || userId !== message.author.id) {
    await message.reply({
      content: "⚠️ You can only request PTO for yourself. Use your @mention or your exact name.",
    });
    return;
  }

  const channel = message.channel;
  const usedPTO = await getUsedPTO(channel, userId);
  const allowedPTO = getAllowedPTO();
  const remaining = allowedPTO - usedPTO;

  if (requestedDays <= remaining) {
    // ✅ Approve
    const totalAfter = usedPTO + requestedDays;
    await message.reply({
      content: `✅ **Approved:** ${message.author} requested **${requestedDays} days** off for _${reason.trim()}_\n📅 **Used:** ${totalAfter.toFixed(1)}/${allowedPTO} days (last 60 days)`,
    });
  } else {
    // ❌ Deny
    await message.reply({
      content: `❌ **Denied:** You've used **${usedPTO.toFixed(1)}/${allowedPTO}** days in the last 60 days.\nYou requested ${requestedDays}, but only **${remaining.toFixed(1)}** days remaining.`,
    });
  }
});

// Login
client.login(TOKEN).catch(err => {
  console.error('❌ Failed to log in. Check your token.');
  console.error(err);
});
