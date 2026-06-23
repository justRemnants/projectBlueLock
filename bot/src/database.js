const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('WARNING: SUPABASE_URL or SUPABASE_KEY is missing from environment variables.');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

/**
 * Get a user's details or create them if they do not exist.
 */
async function getOrCreateUser(discordUser) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('discord_id', discordUser.id)
    .single();

  if (error && error.code === 'PGRST116') {
    // User does not exist, insert them
    const newUser = {
      discord_id: discordUser.id,
      username: discordUser.username,
      display_name: discordUser.globalName || discordUser.username,
      avatar_url: discordUser.avatarURL() || null,
      tokens_balance: 1000
    };
    const { data: insertedData, error: insertError } = await supabase
      .from('users')
      .insert(newUser)
      .select('*')
      .single();

    if (insertError) throw insertError;
    return insertedData;
  } else if (error) {
    throw error;
  }

  // Update avatar or usernames if they changed
  const updatedFields = {};
  if (data.username !== discordUser.username) updatedFields.username = discordUser.username;
  const currentDisplayName = discordUser.globalName || discordUser.username;
  if (data.display_name !== currentDisplayName) updatedFields.display_name = currentDisplayName;
  const currentAvatar = discordUser.avatarURL();
  if (currentAvatar && data.avatar_url !== currentAvatar) updatedFields.avatar_url = currentAvatar;

  if (Object.keys(updatedFields).length > 0) {
    const { data: updatedData } = await supabase
      .from('users')
      .update(updatedFields)
      .eq('discord_id', discordUser.id)
      .select('*')
      .single();
    return updatedData || data;
  }

  return data;
}

/**
 * Fetch matches scheduled for "Today" and "Tomorrow" relative to AEDT/AEST.
 */
async function getActiveMatches() {
  // To match AEDT/AEST (UTC+10 / UTC+11), we retrieve active/upcoming matches.
  // We'll select matches that are not finished ('FT', 'AET', 'PEN' etc. - let's check for status !== 'Finished')
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .order('kickoff_time', { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Get all bets for a specific fixture.
 */
async function getBetsForFixture(fixtureId) {
  const { data, error } = await supabase
    .from('bets')
    .select('*')
    .eq('fixture_id', fixtureId);

  if (error) throw error;
  return data;
}

/**
 * Get the distribution (Spy Metric) for a match.
 */
async function getSpyMetric(fixtureId) {
  const bets = await getBetsForFixture(fixtureId);
  const distribution = {
    home: { tokens: 0, votes: 0 },
    away: { tokens: 0, votes: 0 },
    draw: { tokens: 0, votes: 0 },
    totalTokens: 0,
    totalVotes: 0
  };

  bets.forEach(bet => {
    const pick = bet.team_picked; // 'home', 'away', 'draw'
    if (distribution[pick]) {
      distribution[pick].tokens += bet.amount_wagered;
      distribution[pick].votes += 1;
      distribution.totalTokens += bet.amount_wagered;
      distribution.totalVotes += 1;
    }
  });

  return distribution;
}

/**
 * Calculate the anti-inflation multiplier based on vote share.
 */
function getMultiplier(voteShare) {
  if (voteShare > 0.80) {
    return 1.0;
  } else if (voteShare >= 0.50) {
    return 1.0;
  } else if (voteShare >= 0.20) {
    return 1.25; // Midpoint of 1.2x and 1.3x
  } else {
    return 1.5; // Jackpot boost
  }
}

/**
 * Calculate the estimated earnings for a specific bet amount.
 */
async function calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, userId = null) {
  const bets = await getBetsForFixture(fixtureId);
  
  // Exclude the user's existing bet from calculations if they are updating it
  const otherBets = userId ? bets.filter(b => b.user_id !== userId) : bets;

  let totalPool = amountWagered;
  let winningTokens = teamPicked === 'home' || teamPicked === 'away' || teamPicked === 'draw' ? amountWagered : 0;
  let winningVotes = amountWagered === 0 ? 1 : 0; // if it's a free vote
  let totalVotes = 1;

  otherBets.forEach(bet => {
    totalPool += bet.amount_wagered;
    totalVotes += 1;
    if (bet.team_picked === teamPicked) {
      winningTokens += bet.amount_wagered;
      winningVotes += 1;
    }
  });

  if (amountWagered === 0) {
    // Free Vote System
    return {
      estimated: 5,
      multiplier: 1.0,
      voteShare: totalVotes > 0 ? (winningVotes / totalVotes) : 0,
      isFreeVote: true
    };
  }

  const voteShare = totalPool > 0 ? (winningTokens / totalPool) : 0;
  const multiplier = getMultiplier(voteShare);
  const boostedPool = totalPool * multiplier;
  
  const estimated = winningTokens > 0 
    ? Math.round((boostedPool / winningTokens) * amountWagered)
    : amountWagered;

  return {
    estimated,
    multiplier,
    voteShare,
    isFreeVote: false
  };
}

/**
 * Place or modify a wager.
 */
async function placeBet(userId, fixtureId, teamPicked, amountWagered) {
  // 1. Fetch match kickoff to verify match has not started yet
  const { data: match, error: matchError } = await supabase
    .from('matches')
    .select('*')
    .eq('fixture_id', fixtureId)
    .single();

  if (matchError || !match) throw new Error('Match not found.');
  if (new Date() >= new Date(match.kickoff_time)) {
    throw new Error('This match has already kicked off. Wagers are locked!');
  }

  // 2. Fetch current user balance and previous bet
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('tokens_balance')
    .eq('discord_id', userId)
    .single();

  if (userError || !user) throw new Error('User profile not found.');

  const { data: oldBet } = await supabase
    .from('bets')
    .select('*')
    .eq('user_id', userId)
    .eq('fixture_id', fixtureId)
    .single();

  const oldWager = oldBet ? oldBet.amount_wagered : 0;
  const netTokensNeeded = amountWagered - oldWager;

  if (user.tokens_balance < netTokensNeeded) {
    throw new Error(`Insufficient tokens! You need ${netTokensNeeded} more tokens (Balance: ${user.tokens_balance}).`);
  }

  // 3. Upsert bet
  const { error: betError } = await supabase
    .from('bets')
    .upsert({
      user_id: userId,
      fixture_id: fixtureId,
      team_picked: teamPicked,
      amount_wagered: amountWagered
    }, {
      onConflict: 'user_id,fixture_id'
    });

  if (betError) throw betError;

  // 4. Update user tokens_balance
  const { error: balanceError } = await supabase
    .from('users')
    .update({ tokens_balance: user.tokens_balance - netTokensNeeded })
    .eq('discord_id', userId);

  if (balanceError) throw balanceError;

  return {
    success: true,
    previousBet: oldBet,
    newBet: { user_id: userId, fixture_id: fixtureId, team_picked: teamPicked, amount_wagered: amountWagered },
    newBalance: user.tokens_balance - netTokensNeeded
  };
}

/**
 * Fetch a user's betting history.
 */
async function getUserHistory(userId) {
  const { data, error } = await supabase
    .from('bets')
    .select(`
      *,
      matches (
        home_team,
        away_team,
        kickoff_time,
        status,
        winner
      )
    `)
    .eq('user_id', userId);

  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  getOrCreateUser,
  getActiveMatches,
  getBetsForFixture,
  getSpyMetric,
  calculateEstimatedEarnings,
  placeBet,
  getUserHistory
};
