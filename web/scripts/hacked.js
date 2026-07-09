/**
 * web/scripts/security-breach.js
 * 
 * One-time local trigger script to publish a formatted red security breach announcement
 * directly inside the configured Discord events panel channel.
 */

require('dotenv').config({ path: '../bot/.env' }); // Reads your local credentials
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Service role key
const BOT_TOKEN = process.env.DISCORD_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !BOT_TOKEN) {
  console.error('❌  Error: Missing local environment variables in your bot/.env path!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COLORS = {
  red: 0xff3333 // Red color corresponding to Discord's guidelines
};

async function runSecurityBreach() {
  console.log('🚀  Connecting to Supabase Database to locate channels...');

  // 1. Fetch active panel channel configuration dynamically from Supabase
  const { data: config, error: configErr } = await supabase
    .from('system_config')
    .select('*')
    .in('key', ['panel_channel_id']);

  const channelId = config?.find(d => d.key === 'panel_channel_id')?.value;

  if (configErr || !channelId) {
    console.error('❌  Error: Could not locate panel_channel_id in system_config. Verify the events panel is set up!');
    return;
  }

  console.log(`✅  Located active events channel: ${channelId}`);

  // 2. Build the Styled Security Vulnerability Embed Card
  const breachEmbed = {
    color: COLORS.red,
    title: '🚨  SECURITY VULNERABILITY BREACHED  🚨',
    description: 
      `**CRITICAL SYSTEM PROTOCOL EXPLOITED**\n\n` +
      `An unauthorized database bypass has been identified inside **Sector 4**. Active ledgers and circulating token arrays have experienced a minor sync disruption.\n\n` +
      `🔒  **STATUS: PROTOCOL CONTAINMENT SHIELD INITIATED**\n\n` +
      `• Highly advanced database audits are currently underway.\n` +
      `• Locked prediction wagers are safe and undergoing isolation containment.\n` +
      `• Active terminal interactions remain under secure observation.\n\u200b`,
    fields: [
      {
        name: '📍  Origin Vector',
        value: '`Node-3 // Internal Hack`',
        inline: true
      },
      {
        name: '🕵️‍♂️  System Threat Level',
        value: '`High // Critical Alert`',
        inline: true
      }
    ],
    footer: { text: 'Blue-Lock Mainframe Containment Protocol' },
    timestamp: new Date().toISOString()
  };

  try {
    console.log('📡  Dispatching cryptographic transmission to Discord...');
    
    // 3. Post the alert directly via Discord REST API
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { embeds: [breachEmbed] },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    
    console.log('🎉  Success! The classified security breach alert has been broadcasted to the events channel.');
  } catch (err) {
    console.error('❌  Failed to publish alert to Discord:', err.response?.data || err.message);
  }
}

runSecurityBreach();