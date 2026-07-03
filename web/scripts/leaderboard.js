/**
 * web/scripts/post-leaderboard.js
 * 
 * Local utility script to fetch current standings and publish a public,
 * non-ephemeral leaderboard card directly inside the configured events channel.
 */

require('dotenv').config({ path: '../bot/.env' }); // Reads your live bot's .env variables
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Service role key
const BOT_TOKEN = process.env.DISCORD_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COLORS = {
  gold: 0xf1c40f
};

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

async function postLeaderboard() {
  console.log('🚀 Fetching standings from Supabase database...');

  // 1. Fetch top 10 users by balance
  const { data: users, error } = await supabase
    .from('users')
    .select('username, display_name, tokens_balance')
    .order('tokens_balance', { ascending: false })
    .limit(10);

  if (error || !users) {
    console.error('❌ Failed to retrieve standings:', error?.message);
    return;
  }

  // 2. Format rankings with medals
  const lines = users.map((u, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i+1}\``;
    const name = u.display_name || u.username;
    return `${medal} **${name}** · \`${fmt(u.tokens_balance)} tokens\``;
  });

  const embed = {
    color: COLORS.gold,
    title: '🏆  Leaderboard Standings  •  Project Blue-Lock',
    description: lines.join('\n') || '*No registered competitors yet.*',
    timestamp: new Date().toISOString()
  };

  // 3. Fetch active panel channel configuration from Supabase
  const { data: config, error: configErr } = await supabase
    .from('system_config')
    .select('*')
    .in('key', ['panel_channel_id']);

  const channelId = config?.find(d => d.key === 'panel_channel_id')?.value;

  if (configErr || !channelId) {
    console.error('❌ Could not find panel_channel_id in system_config. Make sure the panel has been set up.');
    return;
  }

  try {
    // 4. Post the public leaderboard directly using Discord REST API
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { embeds: [embed] },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Leaderboard posted successfully in channel: ${channelId}`);
  } catch (err) {
    console.error('❌ Failed to post leaderboard to Discord:', err.response?.data || err.message);
  }
}

postLeaderboard();