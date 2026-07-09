/**
 * scripts/register-commands.js
 *
 * Run this script ONCE to register slash commands with Discord.
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
    name: 'sync',
    description: 'Sync World Cup 2026 fixtures from Football-Data.org.',
    options: [
      {
        type: 5, // BOOLEAN
        name: 'mock',
        description: 'Use mock match data instead of live Football-Data feed',
        required: false
      }
    ]
  },
  {
    name: 'check-api',
    description: 'Check Football-Data.org key status and details.'
  },
  {
    name: 'profile',
    description: 'View your token balance and prediction history.'
  },
  {
    name: 'leaderboard',
    description: 'View the top 10 players on the server.'
  },
  {
    name: 'link-syndicate',
    description: 'Link with your Syndicate co-op partner (Syndicate class only).',
    options: [
      {
        type: 6, // USER type
        name: 'partner',
        description: 'The user you wish to link victory balances with.',
        required: true
      }
    ]
  },
  {
    name: 'top-secret',
    description: 'Access the classified database exploit terminal and cheating logs.'
  },
  {
    name: 'ping',
    description: 'Test the real-time latency and confirm failover routing states between hosts.'
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