/**
 * web/src/footballApi.js
 *
 * Rate-limit aware sync service configured for Football-Data.org v4 API.
 * Refactored to support Syndicate profit bonuses, Syndicate loss token fees,
 * Tank insurance payouts, and automated Nuclear Mode payouts (No pool share on wagers under 100).
 */

require('dotenv').config();
const axios = require('axios');
const { supabase, getConfigValue } = require('./database');

const API_KEY = process.env.FOOTBALL_DATA_KEY;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

const COLORS = {
  blue: 0x1a6bff,
  green: 0x00cc66,
  red: 0xff3333
};

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

async function getWithThrottling(url) {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_KEY is missing.');
  try {
    const response = await axios.get(url, {
      headers: { 'X-Auth-Token': API_KEY },
      timeout: 8000
    });
    return response;
  } catch (err) {
    throw new Error(`API Request failed: ${err.message}`);
  }
}

async function sendDM(userId, embed) {
  try {
    const channelRes = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: userId },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    await axios.post(
      `https://discord.com/api/v10/channels/${channelRes.data.id}/messages`,
      { embeds: [embed] },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
  } catch (err) {
    console.warn(`Could not deliver settlement DM to user ${userId}:`, err.message);
  }
}

async function settleMatch(fixtureId, apiMatch) {
  let winner = null;
  if (apiMatch.score?.winner === 'HOME_TEAM') winner = 'home';
  else if (apiMatch.score?.winner === 'AWAY_TEAM') winner = 'away';
  else if (apiMatch.score?.winner === 'DRAW') winner = 'draw';

  if (!winner) return;

  const homeScore = apiMatch.score?.fullTime?.home ?? apiMatch.score?.regularTime?.home ?? 0;
  const awayScore = apiMatch.score?.fullTime?.away ?? apiMatch.score?.regularTime?.away ?? 0;
  const matchScoreFormatted = `${apiMatch.homeTeam.name} ${homeScore} - ${awayScore} ${apiMatch.awayTeam.name}`;

  const { data: bets } = await supabase
    .from('bets')
    .select('*, users(discord_id, tokens_balance)')
    .eq('fixture_id', fixtureId)
    .eq('settled', false);

  if (!bets || bets.length === 0) return;

  const { data: allBets } = await supabase.from('bets').select('*').eq('fixture_id', fixtureId);

  let totalPool = 0;
  let winningTokens = 0;

  allBets.forEach(b => {
    const virtualWager = b.amount_wagered === 0 ? 5 : b.amount_wagered;
    totalPool += virtualWager;
    if (b.team_picked === winner) {
      winningTokens += virtualWager;
    }
  });

  const voteShare = totalPool > 0 ? winningTokens / totalPool : 0;
  let multiplier = 1.0;
  if (winningTokens < totalPool && winner !== 'draw') {
    if (voteShare > 0.80) multiplier = 1.0;
    else if (voteShare >= 0.50) multiplier = 1.0;
    else if (voteShare >= 0.20) multiplier = 1.10;
    else multiplier = 1.20;
  }

  const boostedPool = totalPool * multiplier;

  for (const b of bets) {
    let payout = 0;
    let isRefund = false;
    let isWinner = false;

    const baseReward = Math.round(b.amount_wagered * 0.20);
    const userClass = await getConfigValue(`class:${b.user_id}`);

    if (winner === 'draw') {
      if (b.team_picked === 'draw') {
        isWinner = true;
        payout = b.amount_wagered + baseReward;
      } else {
        isRefund = true;
        payout = b.amount_wagered;
      }
    } else {
      if (b.team_picked === winner) {
        isWinner = true;
        
        if (b.amount_wagered < 100) {
          payout = b.amount_wagered + baseReward;
        } else {
          payout = Math.round((boostedPool / winningTokens) * b.amount_wagered) + baseReward;
        }

        if (userClass === 'syndicate' && b.amount_wagered > 0) {
          const netWinnings = payout - b.amount_wagered;
          payout = b.amount_wagered + Math.round(netWinnings * 1.15);
        }
      } else {
        if (userClass === 'tank' && b.amount_wagered > 200) {
          payout = Math.round(b.amount_wagered * 0.35);
        } else if (userClass === 'syndicate') {
          payout = -20;
        } else {
          payout = 0;
        }
      }
    }

    const currentBalance = b.users?.tokens_balance || 0;
    const newBalance = Math.max(0, currentBalance + payout);

    await supabase.from('users').update({ tokens_balance: newBalance }).eq('discord_id', b.user_id);
    await supabase.from('bets').update({ settled: true }).eq('bet_id', b.bet_id);

    const embedColor = isRefund ? COLORS.blue : isWinner ? COLORS.green : COLORS.red;
    const outcomeTitle = isRefund ? '↩️ Match Refunded' : isWinner ? '🎉 Prediction Correct!' : '❌ Prediction Incorrect';
    const displayWager = `${fmt(b.amount_wagered)} tokens`;

    const netChange = payout - b.amount_wagered;
    const netChangeStr = isRefund
      ? `Refunded (+0 🪙)`
      : netChange >= 0
        ? `+${fmt(netChange)} 🪙`
        : `-${fmt(Math.abs(netChange))} 🪙`;

    const dmEmbed = {
      color: embedColor,
      title: `${outcomeTitle}  •  ${apiMatch.homeTeam.name} ⚔️ ${apiMatch.awayTeam.name}`,
      description: `Final Score: **${matchScoreFormatted}**\n\u200b`,
      fields: [
        { name: '🔮 Your Prediction', value: `\`${b.team_picked.toUpperCase()}\``, inline: true },
        { name: '🪙 Your Wager', value: `\`${displayWager}\``, inline: true },
        { name: '💰 Payout Outcome', value: `\`${netChangeStr}\``, inline: true },
        { name: '💵 New Balance', value: `\`${fmt(newBalance)} tokens\``, inline: true }
      ],
      footer: { text: 'Thank you for playing Project Blue-Lock! 🍀' },
      timestamp: new Date().toISOString()
    };

    await sendDM(b.user_id, dmEmbed);
  }
}

async function syncFixtures() {
  let response;
  try {
    response = await getWithThrottling('https://api.football-data.org/v4/competitions/WC/matches');
  } catch (err) {
    throw err;
  }

  const matches = response.data.matches;
  if (!matches || matches.length === 0) return { success: false, count: 0, message: 'Returned 0 matches.' };

  const activeMatches = matches.filter(m => m.homeTeam?.name && m.awayTeam?.name);
  if (activeMatches.length === 0) return { success: false, count: 0, message: '0 decided teams.' };

  const { data: dbUnfinished } = await supabase.from('matches').select('fixture_id, status').neq('status', 'FT');

  const upsertData = activeMatches.map(m => {
    let status = 'NS';
    if (m.status === 'FINISHED') status = 'FT';
    else if (['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status)) status = 'LIVE';

    let winner = null;
    if (status === 'FT') {
      if (m.score?.winner === 'HOME_TEAM') winner = 'home';
      else if (m.score?.winner === 'AWAY_TEAM') winner = 'away';
      else if (m.score?.winner === 'DRAW') winner = 'draw';
    }

    return {
      fixture_id: m.id.toString(),
      home_team: m.homeTeam.name,
      away_team: m.awayTeam.name,
      kickoff_time: m.utcDate,
      status: status,
      winner: winner
    };
  });

  const { data: updatedMatches, error } = await supabase
    .from('matches')
    .upsert(upsertData, { onConflict: 'fixture_id' })
    .select();

  if (error) throw error;

  const newlyFinished = activeMatches.filter(apiMatch => {
    const dbMatch = dbUnfinished?.find(dm => dm.fixture_id === apiMatch.id.toString());
    return dbMatch && apiMatch.status === 'FINISHED';
  });

  for (const match of newlyFinished) {
    try {
      await settleMatch(match.id.toString(), match);
    } catch (settleErr) {
      console.error(`[Settlement Failure] Match ID ${match.id}:`, settleErr.message);
    }
  }

  return {
    success: true,
    count: updatedMatches.length,
    message: `Synced **${updatedMatches.length}** fixtures. Processed **${newlyFinished.length}** completed matches.`
  };
}

async function syncMockFixtures() {
  const now = Date.now();
  const h = 3600 * 1000;

  const mock = [
    { fixture_id: 'mock_1', home_team: 'Australia', away_team: 'Germany',
      kickoff_time: new Date(now + 2 * h).toISOString(), status: 'NS', winner: null },
    { fixture_id: 'mock_2', home_team: 'Brazil', away_team: 'Argentina',
      kickoff_time: new Date(now + 5 * h).toISOString(), status: 'NS', winner: null },
    { fixture_id: 'mock_3', home_team: 'France', away_team: 'England',
      kickoff_time: new Date(now + 24 * h + 2 * h).toISOString(), status: 'NS', winner: null },
    { fixture_id: 'mock_4', home_team: 'Spain', away_team: 'Portugal',
      kickoff_time: new Date(now + 24 * h + 6 * h).toISOString(), status: 'NS', winner: null },
    { fixture_id: 'mock_5', home_team: 'USA', away_team: 'Mexico',
      kickoff_time: new Date(now - 3 * h).toISOString(), status: 'FT', winner: 'home' }
  ];

  const { data, error } = await supabase
    .from('matches').upsert(mock, { onConflict: 'fixture_id' }).select();
  if (error) throw error;
  return { success: true, count: data.length, message: `Synced **${data.length}** mock fixtures.` };
}

async function checkApiStatus() {
  try {
    const r = await getWithThrottling('https://api.football-data.org/v4/competitions/WC');
    const headers = r.headers;
    const remaining = headers['x-requests-available-minute'] || headers['x-requestsavailable'] || 'N/A';
    
    return {
      ok: true,
      plan: 'Free Tier',
      requestsRemaining: remaining,
      requestsLimit: '10 req/min',
      message:
        `**API Status:** ✅ Token is valid\n` +
        `**Provider:** Football-Data.org\n` +
        `**Competition:** ${r.data.name || 'FIFA World Cup'}\n` +
        `**Requests available:** ${remaining} before rate limit resets`
    };
  } catch (err) {
    return {
      ok: false,
      message: `**API Error:**\n\`\`\`\n${err.message}\n\`\`\``
    };
  }
}

module.exports = { syncFixtures, syncMockFixtures, checkApiStatus };