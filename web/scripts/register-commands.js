/**
 * scripts/register-commands.js
 *
 * Run this script ONCE to register slash commands with Discord.
 * This replaces the on-startup command registration from the persistent bot.
 *
 * Usage:
 *   cd web
 *   node scripts/register-commands.js
 *
 * Set DISCORD_GUILD_ID to register guild-specific commands instantly (for testing).
 * Leave it empty to register global commands (takes up to 1 hour to propagate).
 */

require('dotenv').config({ path: '../bot/.env' }); // reads the bot's .env
const axios = require('axios');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional

const commands = [
  {
    name: 'setup-panel',
    description: 'Post the Blue-Lock Master Events Panel in this channel.'
  },
  {
    name: 'sync-matches',
    description: 'Sync World Cup 2026 fixtures from API-Football.',
    options: [
      {
        type: 5, // BOOLEAN
        name: 'mock',
        description: 'Use mock match data instead of live API-Football feed',
        required: false
      }
    ]
  },
  {
    name: 'check-api',
    description: 'Check API-Football key status and subscription details.'
  },
  {
    name: 'profile',
    description: 'View your token balance and prediction history.'
  }
];

async function register() {
  const url = GUILD_ID
    ? `https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`
    : `https://discord.com/api/v10/applications/${CLIENT_ID}/commands`;

  try {
    const res = await axios.put(url, commands, {
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅  Registered ${res.data.length} commands ${GUILD_ID ? `to guild ${GUILD_ID}` : 'globally'}.`);
    res.data.forEach(c => console.log(`   • /${c.name}`));
  } catch (err) {
    console.error('❌  Failed to register commands:');
    console.error(err.response?.data || err.message);
  }
}

register();
