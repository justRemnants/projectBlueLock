const axios = require('axios');
const { supabase } = require('./database');
require('dotenv').config();

const API_KEY = process.env.API_FOOTBALL_KEY;
const LEAGUE_ID = 1; // FIFA World Cup league ID in API-Football
const SEASON = 2026;

/**
 * Fetch matches from API-Football and sync them to Supabase matches table.
 */
async function syncFixtures() {
  if (!API_KEY) {
    throw new Error('API_FOOTBALL_KEY is not defined in environment variables.');
  }

  try {
    const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: {
        league: LEAGUE_ID,
        season: SEASON
      },
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    const fixtures = response.data.response;
    if (!fixtures || fixtures.length === 0) {
      return { success: false, message: 'No fixtures found in API response.' };
    }

    const upsertData = fixtures.map(item => {
      const { fixture, teams, goals } = item;
      
      let winner = null;
      if (fixture.status.short === 'FT' || fixture.status.short === 'AET' || fixture.status.short === 'PEN') {
        if (teams.home.winner === true) {
          winner = 'home';
        } else if (teams.away.winner === true) {
          winner = 'away';
        } else {
          winner = 'draw';
        }
      }

      return {
        fixture_id: fixture.id.toString(),
        home_team: teams.home.name,
        away_team: teams.away.name,
        kickoff_time: fixture.date,
        status: fixture.status.short,
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
      message: `Successfully synced ${data.length} World Cup fixtures.`
    };
  } catch (err) {
    console.error('Error syncing fixtures:', err);
    throw err;
  }
}

/**
 * A simulation sync function if API key is not present (for testing).
 */
async function syncMockFixtures() {
  const mockFixtures = [
    {
      fixture_id: 'mock_1',
      home_team: 'Australia',
      away_team: 'Germany',
      kickoff_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours from now
      status: 'NS',
      winner: null
    },
    {
      fixture_id: 'mock_2',
      home_team: 'Brazil',
      away_team: 'Argentina',
      kickoff_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
      status: 'NS',
      winner: null
    },
    {
      fixture_id: 'mock_3',
      home_team: 'USA',
      away_team: 'Mexico',
      kickoff_time: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4 hours ago (Finished)
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
    message: `Successfully synced ${data.length} mock fixtures.`
  };
}

module.exports = {
  syncFixtures,
  syncMockFixtures
};
