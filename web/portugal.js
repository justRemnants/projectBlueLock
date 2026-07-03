/**
 * web/settle-portugal.js
 * 
 * One-time custom script to settle Portugal's victory, distribute wagers,
 * credit an admin bonus, deliver custom DM embeds, and post a server announcement.
 */

require('dotenv').config({ path: '../bot/.env' }); // Reads your live bot's .env variables
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Service role key
const BOT_TOKEN = process.env.DISCORD_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ───────────────────────────────────────────────────────────────────────────
// CONFIGURATION: Set your custom server-wide bonus coins here!
// ───────────────────────────────────────────────────────────────────────────
const BONUS_COINS = 100; // Every player who placed a bet gets this bonus added

const COLORS = {
  green: 0x2ecc71,
  gold: 0xf1c40f
};

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

async function sendDM(userId, embed) {
  try {
    const channelRes = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: userId },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const channelId = channelRes.data.id;

    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { embeds: [embed] },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Custom Payout DM] Delivered victory summary to user ${userId}`);
  } catch (err) {
    console.warn(`[Custom DM Warning] Could not deliver DM to user ${userId}:`, err.response?.data || err.message);
  }
}

async function runSettlement() {
  console.log('🚀 Starting manual custom settlement for Portugal vs Croatia...');

  // 1. Locate the match dynamically
  const { data: match, error: matchErr } = await supabase
    .from('matches')
    .select('*')
    .eq('home_team', 'Portugal')
    .eq('away_team', 'Croatia')
    .single();

  if (matchErr || !match) {
    console.error('❌ Could not find Portugal vs Croatia match in database.');
    return;
  }

  // 2. Mark match as completed in the database
  await supabase
    .from('matches')
    .update({ status: 'FT', winner: 'home' })
    .eq('fixture_id', match.fixture_id);

  console.log(`✅ Match status updated to FINISHED. Winner: PORTUGAL`);

  // 3. Fetch all unsettled wagers on this match
  const { data: bets, error: betsErr } = await supabase
    .from('bets')
    .select('*, users(discord_id, tokens_balance, display_name)')
    .eq('fixture_id', match.fixture_id)
    .eq('settled', false);

  if (betsErr || !bets || bets.length === 0) {
    console.log('ℹ️ No unsettled wagers found to process.');
    return;
  }

  // 4. Distribute payouts, apply bonuses, and DM users
  for (const b of bets) {
    // Proportional Base Reward (20% of wager, with +5 tokens backup safety)
    const baseReward = b.amount_wagered === 0 ? 5 : Math.round(b.amount_wagered * 0.20);
    
    // Calculated winnings + admin bonus tokens
    const standardPayout = b.amount_wagered === 0 ? 5 : (b.amount_wagered + baseReward);
    const payout = standardPayout + BONUS_COINS;

    const currentBalance = b.users?.tokens_balance || 0;
    const newBalance = currentBalance + payout;

    // Update wallet balance in Supabase
    await supabase
      .from('users')
      .update({ tokens_balance: newBalance })
      .eq('discord_id', b.user_id);

    // Mark bet as settled
    await supabase
      .from('bets')
      .update({ settled: true })
      .eq('bet_id', b.bet_id);

    // Custom Portugal SIUUU DM Embed
    const dmEmbed = {
      color: COLORS.green,
      title: '🇵🇹 SIUUUUU! Portugal Triumphs! 🇵🇹',
      description: 
        `LET'S GO PORTUGAL WHOOOOOOOOOO 🔥\n\n` +
        `EVERYONE BETTED RIGHT AND I'M GIVING 100 EXTRA CREDITS 🇵🇹\n\u200b`,
      fields: [
        {
          name: '🔮 Your Prediction',
          value: '`PORTUGAL WIN`',
          inline: true
        },
        {
          name: '🪙 Your Wager',
          value: `\`${b.amount_wagered === 0 ? 'Free Vote' : fmt(b.amount_wagered) + ' tokens'}\``,
          inline: true
        },
        {
          name: '🎁 Admin Bonus',
          value: `\`+${fmt(BONUS_COINS)} tokens\``,
          inline: true
        },
        {
          name: '💰 Payout Received',
          value: `\`+${fmt(payout - b.amount_wagered)} tokens\``,
          inline: true
        },
        {
          name: '💵 New Balance',
          value: `\`${fmt(newBalance)} tokens\``,
          inline: true
        }
      ],
      footer: { text: 'Viva Portugal! 🇵🇹⚽' },
      timestamp: new Date().toISOString()
    };

    await sendDM(b.user_id, dmEmbed);
  }

  // 5. Fetch Master Panel configuration to post a server-wide announcement
  const { data: config } = await supabase
    .from('system_config')
    .select('*')
    .in('key', ['panel_channel_id', 'panel_message_id']);

  const channelId = config?.find(d => d.key === 'panel_channel_id')?.value;

  if (channelId) {
    try {
      const announcementEmbed = {
        color: COLORS.gold,
        title: '📣  WORLD CUP ANNOUNCEMENT  •  PORTUGAL WINS!  📣',
        description: 
          `🇵🇹 **VIVA PORTUGAL!** 🇵🇹\n\n` +
          `WHOOOO PORTUGAL WON THAT WAS SO CLOSE\n\n` +
          `🎁 **ADMIN BONUS:** 100 CREDITS BC THAT MATCH WAS PEAK A BLESSING TO THE EYES\n\n` +
          `* All wagers on this match have been settled.\n` +
          `* Balances and bonuses have been credited.\n` +
          `* Check your **DMs** for your detailed prediction summary!\n\u200b`,
        footer: { text: 'Congratulations to the entire server! 🍀' },
        timestamp: new Date().toISOString()
      };

      await axios.post(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        { embeds: [announcementEmbed] },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      console.log('✅ Server-wide announcement posted successfully.');
    } catch (annError) {
      console.warn('Could not post server-wide announcement:', annError.message);
    }
  }

  console.log('🎉 Manual custom settlement complete!');
}

runSettlement();