/**
 * src/footballApi.js
 *
 * Rate-limit aware sync service configured for Football-Data.org v4 API.
 * Tracks match transitions to automatically process payouts and deliver player DM summaries.
 * Features a fail-safe sweeper and strict 8-second request timeout protections.
 */

require('dotenv').config();
const axios = require('axios');
const { supabase } = require('./database');

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

/**
 * Throttling-aware Axios GET Request wrapper for Football-Data.org with an 8-second timeout.
 */
async function getWithThrottling(url) {
  if (!API_KEY) {
    throw new Error('FOOTBALL_DATA_KEY is missing from environment variables.');
  }

  try {
    const response = await axios.get(url, {
      headers: { 'X-Auth-Token': API_KEY },
      timeout: 8000 // 8-second connection timeout guardrail
    });

    const headers = response.headers;
    const requestsAvailable = parseInt(
      headers['x-requests-available-minute'] || 
      headers['x-requestsavailable'] || 
      '10', 
      10
    );
    const resetSeconds = parseInt(headers['x-requestcounter-reset'] || '0', 10);

    console.log(`[Football-Data API] Quota Remaining: ${requestsAvailable} req/min | Reset in: ${resetSeconds}s`);

    if (requestsAvailable <= 1) {
      console.warn(`[Football-Data API Warning] Only ${requestsAvailable} requests left. Throttling reset in ${resetSeconds}s.`);
    }

    return response;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    throw new Error(`API Request failed (HTTP ${status || 'timeout'}): ${detail}`);
  }
}

/**
 * Securely delivers a direct message (DM) embed with an 8-second timeout.
 */
async function sendDM(userId, embed) {
  try {
    // Step A: Create a DM channel with the recipient
    const channelRes = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: userId },
      { 
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 8000 // Prevents hanging on closed DM configurations
      }
    );
    const channelId = channelRes.data.id;

    // Step B: Post the DM embed
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { embeds: [embed] },
      { 
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 8000
      }
    );
    console.log(`[Settlement DM] Successfully delivered summary to user ${userId}`);
  } catch (err) {
    console.warn(`[Settlement DM Warning] Could not deliver DM to user ${userId}:`, err.response?.data || err.message);
  }
}

/**
 * Processes payouts and logs DM embeds for a completed World Cup fixture.
 */
async function settleMatch(fixtureId, apiMatch) {
  console.log(`[Settlement] Beginning pool processing for completed Match ID: ${fixtureId}`);

  let winner = null;
  if (apiMatch.score?.winner === 'HOME_TEAM') winner = 'home';
  else if (apiMatch.score?.winner === 'AWAY_TEAM') winner = 'away';
  else if (apiMatch.score?.winner === 'DRAW') winner = 'draw';

  if (!winner) {
    console.warn(`[Settlement Skipped] No designated winner received for Match ID: ${fixtureId}`);
    return;
  }

  const { data: bets, error } = await supabase
    .from('bets')
    .select('*, users(discord_id, tokens_balance)')
    .eq('fixture_id', fixtureId)
    .eq('settled', false);

  if (error || !bets || bets.length === 0) {
    console.log(`[Settlement] No unprocessed wagers found for Match ID: ${fixtureId}`);
    return;
  }

  const { data: allBets } = await supabase
    .from('bets')
    .select('*')
    .eq('fixture_id', fixtureId);

  let totalPool = 0;
  let winningTokens = 0;

  allBets.forEach(b => {
    const virtualWager = b.amount_wagered === 0 ? 5 : b.amount_wagered;
    totalPool += virtualWager;
    if (b.team_picked === winner) {
      winningTokens += virtualWager;
    }
  });

  const totalVotes = allBets.length;
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

    // Proportional Base Reward (20% of wager, with +5 tokens backup safety)
    const baseReward = b.amount_wagered === 0 ? 5 : Math.round(b.amount_wagered * 0.20);

    if (winner === 'draw') {
      if (b.team_picked === 'draw') {
        isWinner = true;
        payout = b.amount_wagered + baseReward; // Draws run on 1.0x pool
      } else {
        isRefund = true;
        payout = b.amount_wagered; // Home/Away predictions get a 100% refund
      }
    } else {
      if (b.team_picked === winner) {
        isWinner = true;
        if (b.amount_wagered === 0) {
          payout = 5; // Free Vote payout flat rate
        } else {
          payout = Math.round((boostedPool / winningTokens) * b.amount_wagered) + baseReward;
        }
      } else if (b.team_picked === 'draw') {
        isRefund = true;
        payout = b.amount_wagered;
      } else {
        payout = 0; // Lost standard wager
      }
    }

    const currentBalance = b.users?.tokens_balance || 0;
    const newBalance = currentBalance + payout;

    await supabase
      .from('users')
      .update({ tokens_balance: newBalance })
      .eq('discord_id', b.user_id);

    await supabase
      .from('bets')
      .update({ settled: true })
      .eq('bet_id', b.bet_id);

    const embedColor = isRefund ? COLORS.blue : isWinner ? COLORS.green : COLORS.red;
    const outcomeTitle = isRefund ? '↩️ Match Refunded' : isWinner ? '🎉 Prediction Correct!' : '❌ Prediction Incorrect';

    const displayPick = b.team_picked === 'home'
      ? apiMatch.homeTeam.name.toUpperCase()
      : b.team_picked === 'away'
        ? apiMatch.awayTeam.name.toUpperCase()
        : 'DRAW';

    const netChange = payout - b.amount_wagered;
    const netChangeStr = isRefund
      ? `Refunded (+0 🪙)`
      : netChange >= 0
        ? `+${fmt(netChange)} 🪙`
        : `-${fmt(Math.abs(netChange))} 🪙`;

    const dmEmbed = {
      color: embedColor,
      title: `${outcomeTitle}  •  ${apiMatch.homeTeam.name} ⚔️ ${apiMatch.awayTeam.name}`,
      description: `The match concluded with a final score of **${apiMatch.score?.fullTime?.home ?? 0} - ${apiMatch.score?.fullTime?.away ?? 0}**.\n\u200b`,
      fields: [
        {
          name: '🔮 Your Prediction',
          value: `\`${displayPick}\``,
          inline: true
        },
        {
          name: '🪙 Your Wager',
          value: `\`${b.amount_wagered === 0 ? 'Free Vote' : fmt(b.amount_wagered) + ' tokens'}\``,
          inline: true
        },
        {
          name: '⚡ Multiplier Applied',
          value: `\`${b.amount_wagered === 0 ? 'N/A' : multiplier.toFixed(2) + 'x'}\``,
          inline: true
        },
        {
          name: '💰 Wager Outcome',
          value: `\`${netChangeStr}\``,
          inline: true
        },
        {
          name: '💵 New Balance',
          value: `\`${fmt(newBalance)} tokens\``,
          inline: true
        }
      ],
      footer: { text: 'Thank you for playing Project Blue-Lock! 🍀' },
      timestamp: new Date().toISOString()
    };

    await sendDM(b.user_id, dmEmbed);
  }
}

/**
 * Fetch all World Cup fixtures from Football-Data.org and upsert into Supabase.
 * Checks for matches transitioning to completed status and triggers automated settlement.
 */
async function syncFixtures() {
  let response;
  try {
    response = await getWithThrottling('https://api.football-data.org/v4/competitions/WC/matches');
  } catch (err) {
    throw err;
  }

  const matches = response.data.matches;

  if (!matches || matches.length === 0) {
    return {
      success: false,
      count: 0,
      message: `**Football-Data.org returned 0 matches** for World Cup.\n\nVerify that the competition code "WC" is active on your API dashboard.`
    };
  }

  const activeMatches = matches.filter(m => m.homeTeam?.name && m.awayTeam?.name);

  if (activeMatches.length === 0) {
    return {
      success: false,
      count: 0,
      message: `Football-Data.org returned matches, but **0 of them have decided teams** (all are currently undecided or unassigned tournament slots).`
    };
  }

  const { data: dbUnfinished } = await supabase
    .from('matches')
    .select('fixture_id, status')
    .neq('status', 'FT');

  const upsertData = activeMatches.map(m => {
    let status = 'NS';
    if (m.status === 'FINISHED') status = 'FT';
    else if (['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status)) status = 'LIVE';
    else if (m.status === 'POSTPONED') status = 'PST';

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
      console.error(`[Settlement Failure] Could not settle Match ID: ${match.id}:`, settleErr.message);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FAIL-SAFE SWEEPER: Find ANY completed matches with unsettled bets.
  // ───────────────────────────────────────────────────────────────────────────
  try {
    const { data: unsettledBets } = await supabase
      .from('bets')
      .select('fixture_id')
      .eq('settled', false);

    if (unsettledBets && unsettledBets.length > 0) {
      const backloggedFixtureIds = [...new Set(unsettledBets.map(b => b.fixture_id))];

      const { data: completedMatches } = await supabase
        .from('matches')
        .select('*')
        .in('fixture_id', backloggedFixtureIds)
        .eq('status', 'FT');

      if (completedMatches && completedMatches.length > 0) {
        console.log(`[Sweeper] Detected ${completedMatches.length} backlogged completed matches containing unsettled bets. Processing...`);
        
        for (const match of completedMatches) {
          const apiMatch = activeMatches.find(am => am.id.toString() === match.fixture_id);
          if (apiMatch) {
            await settleMatch(match.fixture_id, apiMatch);
          }
        }
      }
    }
  } catch (sweepErr) {
    console.error(`[Sweeper Error] Automated backlog sweep failed:`, sweepErr.message);
  }

  return {
    success: true,
    count: updatedMatches.length,
    message: `Synced **${updatedMatches.length}** World Cup fixtures from Football-Data.org. Settle-processed **${newlyFinished.length}** newly finished matches.`
  };
}

/**
 * Fetch World Cup competition meta-details to verify API key validity.
 */
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

/**
 * Insert mock fixtures for local testing when needed.
 */
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

module.exports = { syncFixtures, syncMockFixtures, checkApiStatus };