/**
 * web/api/bet.js
 * 
 * Vercel Serverless Function — Secures and processes web-based wagers.
 * Verifies session signatures, enforces kickoff locks, calculates the 30% wealth bet ceiling,
 * writes the wager, and updates the Discord Events Panel.
 */

require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const { getOrCreateUser, getActiveMatches, getUserHistory, placeBet, getPanelMessage } = require('../src/database');
const { buildMasterPanel } = require('../src/panel');

const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const SESSION_SECRET = CLIENT_SECRET || 'fallback-secure-random-secret-string';

function verifyToken(token, secret) {
  try {
    const [payload, signature] = token.split('.');
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    if (signature === expectedSignature) {
      return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    }
  } catch (e) {}
  return null;
}

function sendJson(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

async function editChannelMessage(channelId, messageId, data) {
  await axios.patch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    data,
    { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function refreshPanel() {
  try {
    const config = await getPanelMessage();
    if (!config) return;
    const panelData = await buildMasterPanel();
    await editChannelMessage(config.channelId, config.messageId, panelData);
  } catch (err) {
    console.warn('Panel refresh skipped inside web bet api:', err.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const body = req.body || {};
  const { token, fixtureId, teamPicked, amountWagered } = body;

  if (!token || !fixtureId || !teamPicked || amountWagered === undefined) {
    return sendJson(res, { error: 'Missing required betting parameters.' }, 400);
  }

  // Step A: Verify user session
  const session = verifyToken(token, SESSION_SECRET);
  if (!session || !session.discord_id) {
    return sendJson(res, { error: 'Unauthorized. Invalid session token.' }, 401);
  }

  try {
    // Step B: Fetch fresh user details and match history
    const history = await getUserHistory(session.discord_id);
    const matches = await getActiveMatches();
    
    const match = matches.find(m => m.fixture_id === fixtureId);
    if (!match) {
      return sendJson(res, { error: 'Match not found in the database.' }, 404);
    }

    // Step C: Enforce kickoff lock
    const kickedOff = new Date() >= new Date(match.kickoff_time);
    if (kickedOff || match.status !== 'NS') {
      return sendJson(res, { error: 'Wagers are locked! This match has already started.' }, 400);
    }

    // Step D: Calculate dynamic maximum bet limit (30% total wealth or 300)
    // Filter active wagers excluding the current match being edited
    const otherActiveBets = history.filter(b => b.matches?.status === 'NS' && b.fixture_id !== fixtureId);
    const totalActiveWagered = otherActiveBets.reduce((sum, b) => sum + b.amount_wagered, 0);
    
    // Find previous wager amount on this specific match if they are updating it
    const existingWager = history.find(b => b.fixture_id === fixtureId)?.amount_wagered || 0;

    // Get current wallet balance
    const userProfile = await getOrCreateUser({ id: session.discord_id });
    
    // Total wealth before this bet round started
    const totalWealth = userProfile.tokens_balance + totalActiveWagered + existingWager;
    const maxBet = Math.min(Math.floor(totalWealth * 0.30), 300);

    if (amountWagered > maxBet) {
      return sendJson(res, { 
        error: `Wager exceeds your maximum allowed bet of ${maxBet} tokens (30% of total wealth [${totalWealth}] or 300, whichever is lower).` 
      }, 400);
    }

    // Step E: Place the bet in Supabase (modifies tokens_balance & upserts bet row)
    const result = await placeBet(session.discord_id, fixtureId, teamPicked, amountWagered);

    // Step F: Refresh the Discord Master Panel in the background
    await refreshPanel();

    return sendJson(res, {
      success: true,
      newBalance: result.newBalance,
      wager: result.newBet
    });

  } catch (err) {
    console.error('[Web Bet Error]:', err.message);
    return sendJson(res, { error: err.message || 'Failed to record your wager.' }, 500);
  }
};