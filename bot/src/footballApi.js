/**
 * src/footballApi.js
 *
 * Rate-limit aware sync service configured for Football-Data.org v4 API.
 * Safely inspects headers (X-Requests-Available-Minute, X-RequestCounter-Reset) to handle throttling
 * and filters out undecided placeholder matches to prevent database constraint errors.
 */

require('dotenv').config();
const axios = require('axios');
const { supabase } = require('./database');

const API_KEY = process.env.FOOTBALL_DATA_KEY;

/**
 * Throttling-aware Axios GET Request wrapper for Football-Data.org
 */
async function getWithThrottling(url) {
  if (!API_KEY) {
    throw new Error('FOOTBALL_DATA_KEY is missing from environment variables.');
  }

  try {
    const response = await axios.get(url, {
      headers: { 'X-Auth-Token': API_KEY }
    });

    const headers = response.headers;
    
    // Normalize headers (axios returns lowercase keys)
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
    if (err.response?.status === 429) {
      const resetSeconds = parseInt(err.response.headers['x-requestcounter-reset'] || '60', 10);
      throw new Error(`Rate Limit Exceeded (HTTP 429). Please wait ${resetSeconds} seconds before requesting again.`);
    }
    
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    throw new Error(`API Request failed (HTTP ${status}): ${detail}`);
  }
}

/**
 * Fetch all World Cup fixtures from Football-Data.org and upsert into Supabase.
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

  // Filter out any tournament slots that do not have both team names decided yet (TBD matches)
  const activeMatches = matches.filter(m => m.homeTeam?.name && m.awayTeam?.name);

  if (activeMatches.length === 0) {
    return {
      success: false,
      count: 0,
      message: `Football-Data.org returned matches, but **0 of them have decided teams** (all are currently undecided or unassigned tournament slots).`
    };
  }

  const upsertData = activeMatches.map(m => {
    // Map Football-Data status strings to local schema format
    let status = 'NS';
    if (m.status === 'FINISHED') status = 'FT';
    else if (['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status)) status = 'LIVE';
    else if (m.status === 'POSTPONED') status = 'PST';

    // Map winner strings
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

  const { data, error } = await supabase
    .from('matches')
    .upsert(upsertData, { onConflict: 'fixture_id' })
    .select();

  if (error) throw error;

  return {
    success: true,
    count: data.length,
    message: `Synced **${data.length}** World Cup fixtures from Football-Data.org.`
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