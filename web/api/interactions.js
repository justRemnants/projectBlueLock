/**
 * web/api/interactions.js
 *
 * Vercel Serverless Function — Discord Webhook Interaction Handler
 */

require('dotenv').config();
const { verifyKey } = require('discord-interactions');
const axios = require('axios');

const {
  getOrCreateUser, getActiveMatches,
  calculateEstimatedEarnings, placeBet,
  getUserHistory, savePanelMessage, getPanelMessage
} = require('../src/database');
const { syncFixtures, syncMockFixtures, checkApiStatus } = require('../src/footballApi');
const {
  COLORS, fmt, modal,
  buildMasterPanel, buildMatchDetail, buildBetConfirmEmbed, buildProfileEmbed
} = require('../src/panel');

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_CLIENT_ID;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function editOriginal(token, data) {
  await axios.patch(
    `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`,
    data,
    { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
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
    console.warn('Panel refresh skipped:', err.message);
  }
}

function errorEmbed(msg) {
  return { embeds: [{ color: COLORS.red, title: '❌  Error', description: `\`\`\`\n${msg}\n\`\`\`` }] };
}

const T = { PING: 1, COMMAND: 2, COMPONENT: 3, MODAL_SUBMIT: 5 };
const R = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7, MODAL: 9 };
const FLAGS = { EPHEMERAL: 64 };

async function handleCommand(interaction, res) {
  const name = interaction.data.name;
  const user = interaction.member?.user || interaction.user;
  const token = interaction.token;

  if (name === 'setup-panel') {
    res.json({ type: R.DEFERRED_MESSAGE });
    try {
      const panelData = await buildMasterPanel();
      const editRes = await axios.patch(
        `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`,
        panelData,
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      await savePanelMessage(editRes.data.channel_id, editRes.data.id);
    } catch (err) {
      console.error('setup-panel error:', err.response?.data || err.message);
      await editOriginal(token, errorEmbed('Failed to build the panel. Check server logs.'));
    }
    return;
  }

  if (name === 'sync-matches') {
    res.json({ type: R.DEFERRED_MESSAGE, data: { flags: FLAGS.EPHEMERAL } });
    const useMock = interaction.data.options?.find(o => o.name === 'mock')?.value ?? false;
    try {
      const result = useMock ? await syncMockFixtures() : await syncFixtures();
      const color = result.success ? COLORS.green : COLORS.red;
      await editOriginal(token, {
        embeds: [{
          color,
          title: result.success ? '✅  Sync Complete' : '⚠️  Sync Returned No Data',
          description: result.message,
          timestamp: new Date().toISOString()
        }]
      });
      if (result.success) await refreshPanel();
    } catch (err) {
      await editOriginal(token, errorEmbed(err.message));
    }
    return;
  }

  if (name === 'check-api') {
    res.json({ type: R.DEFERRED_MESSAGE, data: { flags: FLAGS.EPHEMERAL } });
    try {
      const status = await checkApiStatus();
      await editOriginal(token, {
        embeds: [{
          color: status.ok ? COLORS.green : COLORS.red,
          title: '🔍  API-Football Status Check',
          description: status.message,
          timestamp: new Date().toISOString()
        }]
      });
    } catch (err) {
      await editOriginal(token, errorEmbed(err.message));
    }
    return;
  }

  if (name === 'profile') {
    res.json({ type: R.DEFERRED_MESSAGE, data: { flags: FLAGS.EPHEMERAL } });
    try {
      const dbUser = await getOrCreateUser(user);
      const history = await getUserHistory(user.id);
      const activeBets = history.filter(b => b.matches?.status === 'NS');
      const pastBets = history.filter(b => b.matches?.winner);

      await editOriginal(token, {
        embeds: [buildProfileEmbed({ user: dbUser, activeBets, pastBets })]
      });
    } catch (err) {
      await editOriginal(token, errorEmbed(err.message));
    }
    return;
  }
}

async function handleComponent(interaction, res) {
  const customId = interaction.data.custom_id;
  const user = interaction.member?.user || interaction.user;
  const token = interaction.token;

  if (customId === 'select_match') {
    const fixtureId = interaction.data.values[0];
    if (fixtureId === 'none') return res.json({ type: R.DEFERRED_UPDATE });

    res.json({ type: R.DEFERRED_MESSAGE, data: { flags: FLAGS.EPHEMERAL } });
    try {
      const dbUser = await getOrCreateUser(user);
      const matches = await getActiveMatches();
      const match = matches.find(m => m.fixture_id === fixtureId);
      if (!match) return await editOriginal(token, errorEmbed('Match not found.'));

      const detail = await buildMatchDetail(match, dbUser);
      await editOriginal(token, detail);
    } catch (err) {
      await editOriginal(token, errorEmbed(err.message));
    }
    return;
  }

  if (customId.startsWith('select_prediction:')) {
    const fixtureId = customId.split(':')[1];
    const prediction = interaction.data.values[0];

    return res.json(
      modal({
        customId: `wager_modal:${fixtureId}:${prediction}`,
        title: 'Place Your Wager',
        inputs: [{
          customId: 'wager_amount',
          label: 'Token amount (enter 0 for a Free Vote)',
          placeholder: 'e.g. 250',
          minLength: 1,
          maxLength: 6
        }]
      })
    );
  }

  if (customId === 'view_my_history') {
    res.json({ type: R.DEFERRED_MESSAGE, data: { flags: FLAGS.EPHEMERAL } });
    try {
      const dbUser = await getOrCreateUser(user);
      const history = await getUserHistory(user.id);
      const activeBets = history.filter(b => b.matches?.status === 'NS');
      const pastBets = history.filter(b => b.matches?.winner);

      await editOriginal(token, {
        embeds: [buildProfileEmbed({ user: dbUser, activeBets, pastBets })]
      });
    } catch (err) {
      await editOriginal(token, errorEmbed(err.message));
    }
    return;
  }

  if (customId === 'show_rules') {
    return res.json({
      type: R.MESSAGE,
      data: {
        flags: FLAGS.EPHEMERAL,
        embeds: [{
          color: COLORS.gold,
          title: '📖  How to Play  ·  Project Blue-Lock',
          description: '**You start with 500 tokens.** Predict match outcomes to win more.\n\u200b',
          fields: [
            {
              name: '1️⃣  Payout Formula',
              value: 'Winners split the pool proportionally to their wagers:\n```\nPayout = (Boosted Pool ÷ Winning Tokens) × Your Bet + Base Reward\n```'
            },
            {
              name: '2️⃣  Upset Multipliers',
              value: '```\n> 80% vote share  →  1.0x  (favourite, no bonus)\n50–80%           →  1.0x  (standard split)\n20–50%           →  1.10x ⬆  (mild underdog)\n< 20%            →  1.20x  🔥 (miracle jackpot)\n```'
            },
            {
              name: '3️⃣  Free Votes',
              value: 'Wager **0 tokens** to cast a Free Vote.\nFree votes do not affect the main pool.\nA correct free vote earns a flat **+5 tokens**.'
            },
            {
              name: '4️⃣  Base Rewards & Editing',
              value: 'Winning bets receive a **Base Reward** (+5 tokens for bets < 20, +20 tokens for bets ≥ 20).\nYou can update your bet any time before kickoff.'
            }
          ],
          footer: { text: 'Good luck! 🍀' }
        }]
      }
    });
  }
}

async function handleModal(interaction, res) {
  const customId = interaction.data.custom_id;
  const user = interaction.member?.user || interaction.user;
  const token = interaction.token;

  if (customId.startsWith('wager_modal:')) {
    res.json({ type: R.DEFERRED_MESSAGE, data: { flags: FLAGS.EPHEMERAL } });

    const [, fixtureId, teamPicked] = customId.split(':');
    const amountStr = interaction.data.components[0].components[0].value;
    const amountWagered = parseInt(amountStr, 10);

    if (isNaN(amountWagered) || amountWagered < 0) {
      return await editOriginal(token, errorEmbed('Invalid amount. Enter a whole number ≥ 0.'));
    }

    try {
      const result = await placeBet(user.id, fixtureId, teamPicked, amountWagered);
      const estEarnings = await calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, user.id);
      const matches = await getActiveMatches();
      const match = matches.find(m => m.fixture_id === fixtureId);

      await editOriginal(token, {
        embeds: [buildBetConfirmEmbed({
          match,
          teamPicked,
          amountWagered,
          estEarnings,
          newBalance: result.newBalance,
          isUpdate: !!result.previousBet
        })]
      });

      await refreshPanel();
    } catch (err) {
      await editOriginal(token, errorEmbed(err.message));
    }
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await getRawBody(req);
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];

  if (!verifyKey(rawBody, sig, ts, PUBLIC_KEY)) {
    return res.status(401).send('Invalid request signature');
  }

  const interaction = JSON.parse(rawBody.toString('utf-8'));

  if (interaction.type === T.PING) {
    return res.json({ type: R.PONG });
  }

  if (interaction.type === T.COMMAND) return handleCommand(interaction, res);
  if (interaction.type === T.COMPONENT) return handleComponent(interaction, res);
  if (interaction.type === T.MODAL_SUBMIT) return handleModal(interaction, res);

  return res.status(400).send('Unknown interaction type');
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};