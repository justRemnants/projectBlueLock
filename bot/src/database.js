/**
 * bot/src/database.js
 *
 * Database helper optimized for local gateway clients utilizing Discord.js classes.
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

async function getOrCreateUser(discordUser) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('discord_id', discordUser.id)
    .single();

  if (error && error.code === 'PGRST116') {
    const newUser = {
      discord_id: discordUser.id,
      username: discordUser.username,
      display_name: discordUser.globalName || discordUser.username,
      avatar_url: discordUser.avatarURL() || null,
      tokens_balance: 500 // Updated starting balance to 500
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

async function getActiveMatches() {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .order('kickoff_time', { ascending: true });

  if (error) throw error;
  return data;
}

async function getBetsForFixture(fixtureId) {
  const { data, error } = await supabase
    .from('bets')
    .select('*')
    .eq('fixture_id', fixtureId);

  if (error) throw error;
  return data;
}

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
    const pick = bet.team_picked;
    if (distribution[pick]) {
      distribution[pick].tokens += bet.amount_wagered;
      distribution[pick].votes += 1;
      distribution.totalTokens += bet.amount_wagered;
      distribution.totalVotes += 1;
    }
  });

  return distribution;
}

function getMultiplier(voteShare) {
  if (voteShare > 0.80) return 1.0;
  if (voteShare >= 0.50) return 1.0;
  if (voteShare >= 0.20) return 1.10; // Scaled down to 1.10
  return 1.20; // Scaled down to 1.20
}

async function calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, userId = null) {
  const bets = await getBetsForFixture(fixtureId);
  const otherBets = userId ? bets.filter(b => b.user_id !== userId) : bets;

  if (amountWagered === 0) {
    return {
      estimated: 5,
      multiplier: 1.0,
      voteShare: 0,
      isFreeVote: true
    };
  }

  let totalPool = amountWagered;
  let winningTokens = amountWagered;
  otherBets.forEach(b => {
    totalPool += b.amount_wagered;
    if (b.team_picked === teamPicked) winningTokens += b.amount_wagered;
  });

  const voteShare = totalPool > 0 ? winningTokens / totalPool : 0;
  
  // Cap multiplier on draw, unanimous, or single-person bets
  let multiplier = getMultiplier(voteShare);
  if (winningTokens === totalPool || teamPicked === 'draw') {
    multiplier = 1.0;
  }

  const boostedPool = totalPool * multiplier;

  // Base reward structure: +5 tokens if < 20, +20 if >= 20
  const baseReward = amountWagered < 20 ? 5 : 20;

  const estimated = winningTokens > 0 
    ? Math.round((boostedPool / winningTokens) * amountWagered) + baseReward
    : amountWagered + baseReward;

  return {
    estimated,
    multiplier,
    voteShare,
    isFreeVote: false
  };
}

async function placeBet(userId, fixtureId, teamPicked, amountWagered) {
  const { data: match, error: matchError } = await supabase
    .from('matches')
    .select('*')
    .eq('fixture_id', fixtureId)
    .single();

  if (matchError || !match) throw new Error('Match not found.');
  if (new Date() >= new Date(match.kickoff_time)) {
    throw new Error('This match has already kicked off. Wagers are locked!');
  }

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

async function savePanelMessage(channelId, messageId) {
  await supabase
    .from('system_config')
    .upsert([
      { key: 'panel_channel_id', value: channelId },
      { key: 'panel_message_id', value: messageId }
    ], { onConflict: 'key' });
}

async function getPanelMessage() {
  const { data, error } = await supabase
    .from('system_config')
    .select('*')
    .in('key', ['panel_channel_id', 'panel_message_id']);

  if (error || !data || data.length < 2) return null;
  
  const channel = data.find(d => d.key === 'panel_channel_id')?.value;
  const message = data.find(d => d.key === 'panel_message_id')?.value;

  return { channelId: channel, messageId: message };
}

module.exports = {
  supabase,
  getOrCreateUser,
  getActiveMatches,
  getBetsForFixture,
  getSpyMetric,
  calculateEstimatedEarnings,
  placeBet,
  getUserHistory,
  savePanelMessage,
  getPanelMessage
};