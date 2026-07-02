/**
 * web/api/interactions.js
 *
 * Vercel Serverless Function — Discord Webhook Interaction Handler
 * Refactored to use direct responses, ensuring 100% serverless process stability.
 */

require('dotenv').config();
const { verifyKey } = require('discord-interactions');
const axios = require('axios');

const {
  getOrCreateUser, getActiveMatches,
  calculateEstimatedEarnings, placeBet,
  getUserHistory, savePanelMessage, getPanelMessage, supabase
} = require('../src/database');
const { syncFixtures, syncMockFixtures, checkApiStatus } = require('../src/footballApi');
const {
  COLORS, fmt, modal,
  buildMasterPanel, buildMatchDetail, buildBetConfirmEmbed, buildProfileEmbed
} = require('../src/panel');

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_CLIENT_ID;

// Helper to handle JSON responses safely without Express decorations
function sendJson(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

function errorEmbed(msg) {
  return {
    type: 4, // MESSAGE
    data: {
      flags: 64, // EPHEMERAL
      embeds: [{ color: COLORS.red, title: '❌  Error', description: msg }]
    }
  };
}

async function buildLeaderboardEmbed() {
  const { data: users, error } = await supabase
    .from('users')
    .select('username, display_name, tokens_balance')
    .order('tokens_balance', { ascending: false })
    .limit(10);

  if (error || !users) throw new Error('Failed to retrieve standings.');

  const lines = users.map((u, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i+1}\``;
    const name = u.display_name || u.username;
    return `${medal} **${name}** · \`${fmt(u.tokens_balance)} tokens\``;
  });

  return {
    color: COLORS.gold,
    title: '🏆  Leaderboard Standings  •  Project Blue-Lock',
    description: lines.join('\n') || '*No registered competitors yet.*',
    timestamp: new Date().toISOString()
  };
}

const T = { PING: 1, COMMAND: 2, COMPONENT: 3, MODAL_SUBMIT: 5 };
const R = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7, MODAL: 9 };
const FLAGS = { EPHEMERAL: 64 };

async function handleCommand(interaction, res) {
  const name = interaction.data.name;
  const user = interaction.member?.user || interaction.user;
  const channelId = interaction.channel_id;

  if (name === 'setup-panel') {
    try {
      const panelData = await buildMasterPanel();
      
      const response = await axios.post(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        panelData,
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );

      await savePanelMessage(channelId, response.data.id);

      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          content: '✅  Master panel initialized and configured successfully.'
        }
      });
    } catch (err) {
      console.error('setup-panel error:', err.response?.data || err.message);
      
      const discordCode = err.response?.data?.code;
      const discordMsg = err.response?.data?.message || '';
      let errorDetails = '';

      if (discordCode === 50013 || discordMsg.includes('Missing Permissions')) {
        errorDetails = 
          "**Discord API Error: Missing Permissions (Code 50013)**\n\n" +
          "Your bot is blocked from posting the panel in this channel. Please update your **Discord Server settings**:\n\n" +
          "1. **Channel Permission Overrides (Most Common):**\n" +
          "   * Go to this channel's settings -> **Permissions**.\n" +
          "   * Add your bot (or its integration role).\n" +
          "   * Ensure **Send Messages** and **Embed Links** are set to **Allowed (Green Check)**.\n\n" +
          "2. **Global Bot Role:**\n" +
          "   * Go to Server Settings -> **Roles**.\n" +
          "   * Click on your bot's role and ensure **Send Messages** and **Embed Links** are turned on.";
      } else if (discordCode === 50001 || discordMsg.includes('Missing Access')) {
        errorDetails = 
          "**Discord API Error: Missing Access (Code 50001)**\n\n" +
          "Your bot cannot see this channel or lacks basic access. Please check:\n\n" +
          "1. **Channel Visibility:** Ensure the bot's role has **View Channel** allowed.\n" +
          "2. **Scopes:** Ensure you authorized the bot with both `bot` and `applications.commands` checked.";
      } else {
        errorDetails = `Failed to build the panel: \`\`\`\n${discordMsg || err.message}\n\`\`\``;
      }

      return sendJson(res, errorEmbed(errorDetails));
    }
  }

  if (name === 'sync-matches') {
    const useMock = interaction.data.options?.find(o => o.name === 'mock')?.value ?? false;
    try {
      const result = useMock ? await syncMockFixtures() : await syncFixtures();
      const color = result.success ? COLORS.green : COLORS.red;

      sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [{
            color,
            title: result.success ? '✅  Sync Complete' : '⚠️  Sync Returned No Data',
            description: result.message,
            timestamp: new Date().toISOString()
          }]
        }
      });

      if (result.success) {
        await refreshPanel();
      }
    } catch (err) {
      return sendJson(res, errorEmbed(`\`\`\`\n${err.message}\n\`\`\``));
    }
    return;
  }

  if (name === 'check-api') {
    try {
      const status = await checkApiStatus();
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [{
            color: status.ok ? COLORS.green : COLORS.red,
            title: '🔍  API-Football Status Check',
            description: status.message,
            timestamp: new Date().toISOString()
          }]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(`\`\`\`\n${err.message}\n\`\`\``));
    }
  }

  if (name === 'profile') {
    try {
      const dbUser = await getOrCreateUser(user);
      const history = await getUserHistory(user.id);
      
      const activeBets = history.filter(b => !b.settled);
      const pastBets = history.filter(b => b.settled);

      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [buildProfileEmbed({ user: dbUser, activeBets, pastBets })]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(`\`\`\`\n${err.message}\n\`\`\``));
    }
  }

  if (name === 'leaderboard') {
    try {
      const embed = await buildLeaderboardEmbed();
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [embed]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }
}

async function handleComponent(interaction, res) {
  const customId = interaction.data.custom_id;
  const user = interaction.member?.user || interaction.user;

  if (customId === 'select_match') {
    const fixtureId = interaction.data.values[0];
    if (fixtureId === 'none') {
      return sendJson(res, { type: R.DEFERRED_UPDATE });
    }

    try {
      const dbUser = await getOrCreateUser(user);
      const matches = await getActiveMatches();
      const match = matches.find(m => m.fixture_id === fixtureId);
      if (!match) return sendJson(res, errorEmbed('Match not found in the database.'));

      const kickedOff = new Date() >= new Date(match.kickoff_time);
      if (kickedOff || match.status !== 'NS') {
        return sendJson(res, errorEmbed('This match has already kicked off! Predictions are locked.'));
      }

      const detail = await buildMatchDetail(match, dbUser);
      
      // Respond DIRECTLY in the HTTP payload to guarantee stable execution
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: detail.embeds,
          components: detail.components
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(`\`\`\`\n${err.message}\n\`\`\``));
    }
  }

  if (customId.startsWith('select_prediction:')) {
    const fixtureId = customId.split(':')[1];
    const prediction = interaction.data.values[0];

    return sendJson(
      res,
      modal({
        customId: `wager_modal:${fixtureId}:${prediction}`,
        title: 'Place Your Wager',
        inputs: [{
          customId: 'wager_amount',
          label: 'Token amount (enter 0 for a Free Vote)',
          placeholder: 'e.g. 150',
          minLength: 1,
          maxLength: 6
        }]
      })
    );
  }

  if (customId === 'view_my_history') {
    try {
      const dbUser = await getOrCreateUser(user);
      const history = await getUserHistory(user.id);
      
      const activeBets = history.filter(b => !b.settled);
      const pastBets = history.filter(b => b.settled);

      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [buildProfileEmbed({ user: dbUser, activeBets, pastBets })]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(`\`\`\`\n${err.message}\n\`\`\``));
    }
  }

  if (customId === 'view_leaderboard') {
    try {
      const embed = await buildLeaderboardEmbed();
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [embed]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'show_rules') {
    return sendJson(res, {
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
              name: '4️⃣  Base Rewards & Limits',
              value: 'Winning bets receive a **Base Reward** (+5 tokens for bets < 20, +20 tokens for bets ≥ 20).\n\n⚠️ **Bet Limit:** Your maximum allowed wager on any single match is **30% of your total wealth** (balance + active bets) or **300 tokens**, whichever is **lower**.'
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

  if (customId.startsWith('wager_modal:')) {
    const [, fixtureId, teamPicked] = customId.split(':');
    const amountStr = interaction.data.components[0].components[0].value;
    const amountWagered = parseInt(amountStr, 10);

    if (isNaN(amountWagered) || amountWagered < 0) {
      return sendJson(res, errorEmbed('Invalid amount. Enter a whole number ≥ 0.'));
    }

    try {
      const dbUser = await getOrCreateUser(user);
      const history = await getUserHistory(user.id);
      
      const otherActiveBets = history.filter(b => !b.settled && b.fixture_id !== fixtureId);
      const totalActiveWagered = otherActiveBets.reduce((sum, b) => sum + b.amount_wagered, 0);
      
      const existingWager = history.find(b => b.fixture_id === fixtureId)?.amount_wagered || 0;
      
      const totalWealth = dbUser.tokens_balance + totalActiveWagered + existingWager;
      const maxBet = Math.min(Math.floor(totalWealth * 0.30), 300);

      if (amountWagered > maxBet) {
        return sendJson(res, errorEmbed(
          `Wager declined! Your maximum allowable bet is ${maxBet} tokens.\n` +
          `*(Calculated as the lower of 30% of your Total Wealth [${fmt(totalWealth)}🪙] or 300 tokens)*`
        ));
      }

      const result = await placeBet(user.id, fixtureId, teamPicked, amountWagered);
      const estEarnings = await calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, user.id);
      const matches = await getActiveMatches();
      const match = matches.find(m => m.fixture_id === fixtureId);

      sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [buildBetConfirmEmbed({
            match,
            teamPicked,
            amountWagered,
            estEarnings,
            newBalance: result.newBalance,
            isUpdate: !!result.previousBet
          })]
        }
      });

      await refreshPanel();
    } catch (err) {
      return sendJson(res, errorEmbed(`\`\`\`\n${err.message}\n\`\`\``));
    }
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];

  if (!verifyKey(rawBody, sig, ts, PUBLIC_KEY)) {
    res.statusCode = 401;
    res.end('Invalid request signature');
    return;
  }

  const interaction = JSON.parse(rawBody.toString('utf-8'));

  if (interaction.type === T.PING) {
    return sendJson(res, { type: R.PONG });
  }

  if (interaction.type === T.COMMAND) return handleCommand(interaction, res);
  if (interaction.type === T.COMPONENT) return handleComponent(interaction, res);
  if (interaction.type === T.MODAL_SUBMIT) return handleModal(interaction, res);

  res.statusCode = 400;
  res.end('Unknown interaction type');
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};