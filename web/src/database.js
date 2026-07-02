/**
 * web/src/database.js
 *
 * Database helpers optimized for JSON interaction payloads received via webhook.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder_key'
);

function avatarUrl(userId, hash) {
  if (!hash) return null;
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=256`;
}

async function getOrCreateUser(user) {
  const avatarHash = user.avatar;
  const displayName = user.global_name || user.username;

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('discord_id', user.id)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: inserted, error: insertErr } = await supabase
      .from('users')
      .insert({
        discord_id: user.id,
        username: user.username,
        display_name: displayName,
        avatar_url: avatarUrl(user.id, avatarHash),
        tokens_balance: 500
      })
      .select('*')
      .single();
    if (insertErr) throw insertErr;
    return inserted;
  } else if (error) {
    throw error;
  }

  const updates = {};
  if (data.username !== user.username) updates.username = user.username;
  if (data.display_name !== displayName) updates.display_name = displayName;
  const av = avatarUrl(user.id, avatarHash);
  if (av && data.avatar_url !== av) updates.avatar_url = av;

  if (Object.keys(updates).length) {
    const { data: updated } = await supabase
      .from('users').update(updates).eq('discord_id', user.id).select('*').single();
    return updated || data;
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
    .from('bets').select('*').eq('fixture_id', fixtureId);
  if (error) throw error;
  return d;
}

async function getSpyMetric(fixtureId) {
  const bets = await getBetsForFixture(fixtureId);
  const d = {
    home: { tokens: 0, votes: 0 },
    away: { tokens: 0, votes: 0 },
    draw: { tokens: 0, votes: 0 },
    totalTokens: 0, totalVotes: 0
  };
  bets.forEach(b => {
    if (d[b.team_picked]) {
      // Free votes virtually add 5 tokens to the statistical display pool
      const tokenValue = b.amount_wagered === 0 ? 5 : b.amount_wagered;
      d[b.team_picked].tokens += tokenValue;
      d[b.team_picked].votes += 1;
      d.totalTokens += tokenValue;
      d.totalVotes += 1;
    }
  });
  return d;
}

function getMultiplier(voteShare) {
  if (voteShare > 0.80) return 1.0;
  if (voteShare >= 0.50) return 1.0;
  if (voteShare >= 0.20) return 1.10;
  return 1.20;
}

async function calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, userId = null) {
  const bets = await getBetsForFixture(fixtureId);
  const otherBets = userId ? bets.filter(b => b.user_id !== userId) : bets;

  if (amountWagered === 0) {
    return { estimated: 5, multiplier: 1.0, isFreeVote: true };
  }

  // Start pool calculations with current player's wager
  let totalPool = amountWagered;
  let winningTokens = amountWagered;

  otherBets.forEach(b => {
    // Treat other players' Free Votes as a virtual +5 token contribution
    const virtualWager = b.amount_wagered === 0 ? 5 : b.amount_wagered;
    totalPool += virtualWager;
    if (b.team_picked === teamPicked) {
      winningTokens += virtualWager;
    }
  });

  const voteShare = totalPool > 0 ? winningTokens / totalPool : 0;
  
  let multiplier = getMultiplier(voteShare);
  if (winningTokens === totalPool || teamPicked === 'draw') {
    multiplier = 1.0;
  }

  const boostedPool = totalPool * multiplier;
  
  // Dynamic base reward: 20% of the amount wagered
  const baseReward = Math.round(amountWagered * 0.20);

  const estimated = winningTokens > 0 
    ? Math.round((boostedPool / winningTokens) * amountWagered) + baseReward
    : amountWagered + baseReward;

  return { estimated, multiplier, voteShare, isFreeVote: false };
}

async function placeBet(userId, fixtureId, teamPicked, amountWagered) {
  const { data: match, error: matchErr } = await supabase
    .from('matches').select('*').eq('fixture_id', fixtureId).single();
  if (matchErr || !match) throw new Error('Match not found.');
  if (new Date() >= new Date(match.kickoff_time)) throw new Error('Match has kicked off — wagers are locked!');

  const { data: user, error: userErr } = await supabase
    .from('users').select('tokens_balance').eq('discord_id', userId).single();
  if (userErr || !user) throw new Error('User profile not found.');

  const { data: oldBet } = await supabase
    .from('bets').select('*').eq('user_id', userId).eq('fixture_id', fixtureId).single();

  const oldWager = oldBet ? oldBet.amount_wagered : 0;
  const netCost = amountWagered - oldWager;
  if (user.tokens_balance < netCost) {
    throw new Error(`Not enough tokens! Need ${netCost} more (Balance: ${user.tokens_balance}).`);
  }

  const { error: betErr } = await supabase
    .from('bets')
    .upsert({ user_id: userId, fixture_id: fixtureId, team_picked: teamPicked, amount_wagered: amountWagered },
      { onConflict: 'user_id,fixture_id' });
  if (betErr) throw betErr;

  const { error: balErr } = await supabase
    .from('users').update({ tokens_balance: user.tokens_balance - netCost }).eq('discord_id', userId);
  if (balErr) throw balErr;

  return {
    success: true,
    previousBet: oldBet,
    newBet: { user_id: userId, fixture_id: fixtureId, team_picked: teamPicked, amount_wagered: amountWagered },
    newBalance: user.tokens_balance - netCost
  };
}

async function getUserHistory(userId) {
  const { data, error } = await supabase
    .from('bets')
    .select(`*, matches(home_team, away_team, kickoff_time, status, winner)`)
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
    .from('system_config').select('*')
    .in('key', ['panel_channel_id', 'panel_message_id']);
  if (error || !data || data.length < 2) return null;
  return {
    channelId: data.find(d => d.key === 'panel_channel_id')?.value,
    messageId: data.find(d => d.key === 'panel_message_id')?.value
  };
}

module.exports = {
  supabase, getOrCreateUser, getActiveMatches, getBetsForFixture,
  getSpyMetric, calculateEstimatedEarnings, placeBet,
  getUserHistory, savePanelMessage, getPanelMessage
};