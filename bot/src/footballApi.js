const axios = require('axios');
const { supabase } = require('./database');
require('dotenv').config();

const API_KEY = process.env.API_FOOTBALL_KEY;

// FIFA World Cup 2026 = League ID 1, Season 2026
// NOTE: on the free tier you may need to check your API dashboard to confirm
// the correct league ID — visit https://dashboard.api-sports.io and check
// the "Leagues" endpoint to verify league IDs available on your subscription.
const LEAGUE_ID = 1;
const SEASON = 2026;

/**
 * Fetch all World Cup 2026 fixtures from API-Football and upsert into Supabase.
 */
async function syncFixtures() {
  if (!API_KEY) throw new Error('API_FOOTBALL_KEY is not set in your .env file.');

  // Step 1: Check what leagues are available on your plan (debug)
  let availableLeagues = [];
  try {
    const leagueCheck = await axios.get('https://v3.football.api-sports.io/leagues', {
      params: { season: SEASON },
      headers: {
        'x-apisports-key': API_KEY
      }
    });
    availableLeagues = leagueCheck.data.response.map(l =>
      `ID ${l.league.id}: ${l.league.name} (${l.country?.name || 'Global'})`
    );
    console.log(`API returned ${availableLeagues.length} leagues for season ${SEASON}`);
    if (availableLeagues.length < 10) {
      // Only print all if there are few (free tier may be limited)
      console.log('Available leagues:', availableLeagues.join('\n'));
    }
  } catch (e) {
    console.warn('Could not fetch leagues list for debug:', e.message);
  }

  // Step 2: Fetch the actual fixtures
  const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
    params: { league: LEAGUE_ID, season: SEASON },
    headers: {
      'x-apisports-key': API_KEY
    }
  });

  // Log the raw API response header info for debugging
  const remaining = response.headers['x-ratelimit-requests-remaining'];
  const limit = response.headers['x-ratelimit-requests-limit'];
  console.log(`API quota: ${remaining}/${limit} requests remaining today`);
  console.log(`Fixtures returned by API: ${response.data.results}`);

  const fixtures = response.data.response;
  if (!fixtures || fixtures.length === 0) {
    // Provide a helpful error with debug info
    return {
      success: false,
      message: `No fixtures returned for League ID ${LEAGUE_ID}, Season ${SEASON}.\n` +
        `Check: (1) your API key is valid, (2) League ID 1 is included in your plan,\n` +
        `(3) the World Cup 2026 season is available. API quota: ${remaining}/${limit}.`
    };
  }

  const upsertData = fixtures.map(item => {
    const { fixture, teams } = item;

    let winner = null;
    const finishedStatuses = ['FT', 'AET', 'PEN'];
    if (finishedStatuses.includes(fixture.status.short)) {
      if (teams.home.winner === true) winner = 'home';
      else if (teams.away.winner === true) winner = 'away';
      else winner = 'draw';
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
    .from('matches')
    .upsert(upsertData, { onConflict: 'fixture_id' })
    .select();

  if (error) throw error;

  return {
    success: true,
    count: data.length,
    message: `Synced **${data.length}** World Cup 2026 fixtures from API-Football.`
  };
}

/**
 * Insert mock fixtures for local development and testing.
 */
async function syncMockFixtures() {
  const now = Date.now();
  const hour = 3600 * 1000;
  const day = 86400 * 1000;

  const mockFixtures = [
    {
      fixture_id: 'mock_1',
      home_team: 'Australia',
      away_team: 'Germany',
      kickoff_time: new Date(now + 2 * hour).toISOString(),
      status: 'NS',
      winner: null
    },
    {
      fixture_id: 'mock_2',
      home_team: 'Brazil',
      away_team: 'Argentina',
      kickoff_time: new Date(now + 6 * hour).toISOString(),
      status: 'NS',
      winner: null
    },
    {
      fixture_id: 'mock_3',
      home_team: 'France',
      away_team: 'England',
      kickoff_time: new Date(now + day + 2 * hour).toISOString(),
      status: 'NS',
      winner: null
    },
    {
      fixture_id: 'mock_4',
      home_team: 'Spain',
      away_team: 'Portugal',
      kickoff_time: new Date(now + day + 6 * hour).toISOString(),
      status: 'NS',
      winner: null
    },
    {
      fixture_id: 'mock_5',
      home_team: 'USA',
      away_team: 'Mexico',
      kickoff_time: new Date(now - 4 * hour).toISOString(),
      status: 'FT',
      winner: 'home'
    }
  ];

  const { data, error } = await supabase
    .from('matches')
    .upsert(mockFixtures, { onConflict: 'fixture_id' })
    .select();

  if (error) throw error;
  return {
    success: true,
    count: data.length,
    message: `Synced **${data.length}** mock fixtures (Today & Tomorrow in AEST).`
  };
}

module.exports = { syncFixtures, syncMockFixtures };
