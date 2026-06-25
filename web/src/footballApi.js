require('dotenv').config();
const axios = require('axios');
const { supabase } = require('./database');

const API_KEY = process.env.API_FOOTBALL_KEY;
// World Cup 2026 = League 1 on API-Sports. Verify at:
// https://v3.football.api-sports.io/leagues?name=FIFA+World+Cup
const LEAGUE_ID = 1;
const SEASON = 2026;

async function syncFixtures() {
  if (!API_KEY) throw new Error('API_FOOTBALL_KEY is missing from environment variables.');

  let response;
  try {
    response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { league: LEAGUE_ID, season: SEASON },
      headers: { 'x-apisports-key': API_KEY }
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    throw new Error(`API-Football request failed (HTTP ${status}): ${detail}`);
  }

  const quota = {
    remaining: response.headers['x-ratelimit-requests-remaining'],
    limit: response.headers['x-ratelimit-requests-limit']
  };

  // Check for API-level errors
  if (response.data.errors && Object.keys(response.data.errors).length > 0) {
    throw new Error(`API error: ${JSON.stringify(response.data.errors)}`);
  }

  const fixtures = response.data.response;

  if (!fixtures || fixtures.length === 0) {
    return {
      success: false,
      count: 0,
      quota,
      message: `**API returned 0 fixtures** for League ${LEAGUE_ID}, Season ${SEASON}.\n\nDebug info:\n• Quota: ${quota.remaining}/${quota.limit} requests left\n• This usually means the World Cup season isn't loaded yet on your subscription tier.\n• Try the \`/check-api\` command to see what leagues are available.`
    };
  }

  const upsertData = fixtures.map(({ fixture, teams }) => {
    let winner = null;
    if (['FT', 'AET', 'PEN'].includes(fixture.status.short)) {
      winner = teams.home.winner ? 'home' : teams.away.winner ? 'away' : 'draw';
    }
    return {
      fixture_id: fixture.id.toString(),
      home_team: teams.home.name,
      away_team: teams.away.name,
      kickoff_time: fixture.date,
      status: fixture.status.short,
      winner
    };
  });

  const { data, error } = await supabase
    .from('matches').upsert(upsertData, { onConflict: 'fixture_id' }).select();
  if (error) throw error;

  return {
    success: true,
    count: data.length,
    quota,
    message: `Synced **${data.length}** World Cup 2026 fixtures. (Quota: ${quota.remaining}/${quota.limit} remaining)`
  };
}

/**
 * Fetch available leagues for debugging API key / subscription issues.
 */
async function checkApiStatus() {
  if (!API_KEY) return { ok: false, message: 'API_FOOTBALL_KEY is not set.' };
  try {
    const r = await axios.get('https://v3.football.api-sports.io/status', {
      headers: { 'x-apisports-key': API_KEY }
    });
    const s = r.data.response;
    return {
      ok: true,
      plan: s?.subscription?.plan || 'Unknown',
      requestsRemaining: r.headers['x-ratelimit-requests-remaining'],
      requestsLimit: r.headers['x-ratelimit-requests-limit'],
      message:
        `**API Status:** ✅ Key is valid\n` +
        `**Plan:** ${s?.subscription?.plan || 'Unknown'}\n` +
        `**Requests today:** ${r.headers['x-ratelimit-requests-remaining']}/${r.headers['x-ratelimit-requests-limit']} remaining\n` +
        `**Ends:** ${s?.subscription?.end || 'N/A'}`
    };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    return {
      ok: false,
      message: `**API Error (HTTP ${status}):**\n\`\`\`json\n${JSON.stringify(detail, null, 2)}\n\`\`\``
    };
  }
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
  return { success: true, count: data.length, message: `Synced **${data.length}** mock fixtures (2 today, 2 tomorrow, 1 finished).` };
}

module.exports = { syncFixtures, syncMockFixtures, checkApiStatus };
