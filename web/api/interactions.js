/**
 * web/api/interactions.js
 *
 * Vercel Serverless Function — Discord Webhook Interaction Handler
 * Upgraded to support automated class selections, Golden Tickets, the localized Match Audit panel,
 * and the 100% complete execution of all panel updates before termination.
 */

require('dotenv').config();
const { verifyKey } = require('discord-interactions');
const axios = require('axios');

const {
  getOrCreateUser, getActiveMatches,
  calculateEstimatedEarnings, placeBet,
  getUserHistory, savePanelMessage, getPanelMessage, supabase,
  getConfigValue, setConfigValue, getUserStreak
} = require('../src/database');
const { syncFixtures, syncMockFixtures, checkApiStatus } = require('../src/footballApi');
const {
  COLORS, fmt, modal,
  buildMasterPanel, buildMatchDetail, buildBetConfirmEmbed, buildProfileEmbed, buildAdminHistoryPage
} = require('../src/panel');

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_CLIENT_ID;

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
    { 
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 8000
    }
  );
}

async function refreshPanel() {
  try {
    const config = await getPanelMessage();
    if (!config) return;
    const panelData = await buildMasterPanel();
    await editChannelMessage(config.channelId, config.messageId, panelData);
  } catch (err) {
    console.warn('Panel refresh failed inside endpoint handler:', err.message);
  }
}

function errorEmbed(msg) {
  return {
    type: 4,
    data: {
      flags: 64,
      embeds: [{ color: COLORS.red, title: '❌  Error', description: msg }]
    }
  };
}

async function buildLeaderboardEmbed() {
  const { data: users, error } = await supabase
    .from('users')
    .select('username, display_name, tokens_balance, discord_id')
    .order('tokens_balance', { ascending: false })
    .limit(10);

  if (error || !users) throw new Error('Failed to retrieve standings.');

  const lines = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i+1}\``;
    const name = u.display_name || u.username;
    const uClass = await getConfigValue(`class:${u.discord_id}`) || 'None';
    const streak = await getUserStreak(u.discord_id);
    const streakIndicator = streak >= 2 ? ` 🔥 x${streak}` : '';
    lines.push(`${medal} **${name}** (${uClass.toUpperCase()}${streakIndicator}) · \`${fmt(u.tokens_balance)} tokens\``);
  }

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
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      await savePanelMessage(channelId, response.data.id);
      return sendJson(res, {
        type: R.MESSAGE,
        data: { flags: FLAGS.EPHEMERAL, content: '✅  Master panel initialized and configured successfully.' }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (name === 'sync-matches') {
    const useMock = interaction.data.options?.find(o => o.name === 'mock')?.value ?? false;
    try {
      const result = useMock ? await syncMockFixtures() : await syncFixtures();
      if (result.success) {
        // Essential: Await refresh BEFORE terminating connection to prevent Vercel container freeze
        await refreshPanel();
      }
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [{
            color: result.success ? COLORS.green : COLORS.red,
            title: result.success ? '✅  Sync Complete' : '⚠️  Sync Returned No Data',
            description: result.message,
            timestamp: new Date().toISOString()
          }]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (name === 'profile') {
    try {
      const dbUser = await getOrCreateUser(user);
      const history = await getUserHistory(user.id);
      const activeBets = history.filter(b => !b.settled);
      const pastBets = history.filter(b => b.settled);
      const profile = await buildProfileEmbed(dbUser, activeBets, pastBets);

      return sendJson(res, {
        type: R.MESSAGE,
        data: { flags: FLAGS.EPHEMERAL, embeds: [profile.embeds[0]], components: profile.components }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (name === 'leaderboard') {
    try {
      const embed = await buildLeaderboardEmbed();
      return sendJson(res, { type: R.MESSAGE, data: { flags: FLAGS.EPHEMERAL, embeds: [embed] } });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }
}

async function handleComponent(interaction, res) {
  const customId = interaction.data.custom_id;
  const user = interaction.member?.user || interaction.user;

  if (customId.startsWith('admin_history_page:')) {
    const [, pageStr, sortBy] = customId.split(':');
    const pageNum = parseInt(pageStr, 10);
    try {
      const panel = await buildAdminHistoryPage(pageNum, sortBy);
      return sendJson(res, { type: R.UPDATE_MESSAGE, data: { embeds: panel.embeds, components: panel.components } });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId.startsWith('admin_history_sort:')) {
    const [, pageStr] = customId.split(':');
    const pageNum = parseInt(pageStr, 10);
    const sortBy = interaction.data.values[0];
    try {
      const panel = await buildAdminHistoryPage(pageNum, sortBy);
      return sendJson(res, { type: R.UPDATE_MESSAGE, data: { embeds: panel.embeds, components: panel.components } });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'select_class_role') {
    const chosenClass = interaction.data.values[0];
    try {
      await setConfigValue(`class:${user.id}`, chosenClass);
      return sendJson(res, {
        type: R.MESSAGE,
        data: { flags: FLAGS.EPHEMERAL, content: `🔮  Your Class has been set to **${chosenClass.toUpperCase()}**! Use /profile to view your updated status.` }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'toggle_oracle_shield') {
    try {
      const current = await getConfigValue(`oracle_shield:${user.id}`) || 'off';
      const nextState = current === 'on' ? 'off' : 'on';
      await setConfigValue(`oracle_shield:${user.id}`, nextState);
      return sendJson(res, {
        type: R.MESSAGE,
        data: { flags: FLAGS.EPHEMERAL, content: `🔮  Oracle Streak Shield toggled **${nextState.toUpperCase()}**!` }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'link_syndicate_prompt') {
    return sendJson(res, {
      type: R.MESSAGE,
      data: {
        flags: FLAGS.EPHEMERAL,
        content: '🤝  To link your Syndicate partner, run the command: `/link-syndicate @User`'
      }
    });
  }

  if (customId === 'select_match') {
    const fixtureId = interaction.data.values[0];
    if (fixtureId === 'none') return sendJson(res, { type: R.DEFERRED_UPDATE });

    try {
      const dbUser = await getOrCreateUser(user);
      const matches = await getActiveMatches();
      const match = matches.find(m => m.fixture_id === fixtureId);
      if (!match) return sendJson(res, errorEmbed('Match not found.'));

      if (new Date() >= new Date(match.kickoff_time) || match.status !== 'NS') {
        return sendJson(res, errorEmbed('This match has kicked off! Predictions are locked.'));
      }

      const detail = await buildMatchDetail(match, dbUser);
      return sendJson(res, { type: R.MESSAGE, data: { flags: FLAGS.EPHEMERAL, embeds: [detail.embeds[0]], components: detail.components } });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId.startsWith('select_prediction:')) {
    const fixtureId = customId.split(':')[1];
    const prediction = interaction.data.values[0];

    return sendJson(res, modal({
      customId: `wager_modal:${fixtureId}:${prediction}`,
      title: 'Place Your Wager',
      inputs: [{
        customId: 'wager_amount',
        label: 'Token amount (enter 0 for a Free Vote)',
        placeholder: 'e.g. 150',
        minLength: 1,
        maxLength: 6
      }]
    }));
  }

  if (customId.startsWith('apply_ticket:')) {
    const fixtureId = customId.split(':')[1];
    try {
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const rawTickets = await supabase.from('system_config').select('key').like('key', `ticket_used:${user.id}:%`);
      const ticketsUsed = rawTickets.data?.length || 0;
      const maxTickets = userClass === 'renegade' ? 2 : 1;

      if (ticketsUsed >= maxTickets) {
        return sendJson(res, errorEmbed(`You have no Golden Tickets remaining (Used ${ticketsUsed}/${maxTickets}).`));
      }

      await setConfigValue(`ticket_used:${user.id}:${fixtureId}`, 'true');
      return sendJson(res, {
        type: R.MESSAGE,
        data: { flags: FLAGS.EPHEMERAL, content: '🎟️  **Golden Ticket Applied!** Your profit on this bet will be doubled if correct.' }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId.startsWith('audit_match_prompt:')) {
    const fixtureId = customId.split(':')[1];
    try {
      const bets = await supabase.from('bets').select('user_id').eq('fixture_id', fixtureId);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'auditor' ? 15 : 30;

      if (!bets.data || bets.data.length <= 1) {
        return sendJson(res, errorEmbed('No other competitors have placed wagers on this match yet.'));
      }

      const otherBettors = bets.data.filter(b => b.user_id !== user.id);
      const options = otherBettors.map(b => ({
        label: `Audit competitor ID: ${b.user_id.substring(0, 15)}...`,
        value: `${b.user_id}:${fixtureId}`
      }));

      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          content: `🔍  **Security Audit Interface**\nCost: \`${cost} tokens\`. Select a competitor to audit on this match:`,
          components: [{
            type: 1,
            components: [{
              type: 3,
              custom_id: 'perform_user_audit',
              placeholder: 'Select a player to investigate...',
              options: options
            }]
          }]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'perform_user_audit') {
    const [targetId, fixtureId] = interaction.data.values[0].split(':');
    try {
      const dbUser = await getOrCreateUser(user);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'auditor' ? 15 : 30;

      if (dbUser.tokens_balance < cost) {
        return sendJson(res, errorEmbed(`Insufficient tokens! An audit costs ${cost} tokens (Balance: ${dbUser.tokens_balance}).`));
      }

      // Deduct audit cost
      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);

      // Perform Audit Verification
      const cheatUsed = await getConfigValue(`cheat:${targetId}:${fixtureId}`);
      if (cheatUsed) {
        // Target is GUILTY
        const penaltyFine = userClass === 'tank' ? 50 : 100;
        const targetUser = await supabase.from('users').select('*').eq('discord_id', targetId).single();
        const currentTargetBal = targetUser.data?.tokens_balance || 0;

        await supabase.from('users').update({ tokens_balance: Math.max(0, currentTargetBal - penaltyFine) }).eq('discord_id', targetId);
        await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost + 150 }).eq('discord_id', user.id);
        await setConfigValue(`cheat:${targetId}:${fixtureId}`, ''); // Clear the cheat record

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            content: `🚨  **WHISTLEBLOWER BREACH**  🚨\n<@${user.id}> caught <@${targetId}> cheating on match ID: ${fixtureId}!\n` +
                     `• <@${targetId}> has been fined **${penaltyFine} tokens** and their cheat bet is nullified.\n` +
                     `• <@${user.id}> has received a **+150 token Bounty Reward**!`
          }
        });
      } else {
        // Target is INNOCENT - Accuser loses audit tokens which are transferred to target as damages
        const targetUser = await supabase.from('users').select('*').eq('discord_id', targetId).single();
        const targetBal = targetUser.data?.tokens_balance || 0;
        await supabase.from('users').update({ tokens_balance: targetBal + cost }).eq('discord_id', targetId);

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `🛡️  *Audit complete.* User is innocent! Your ${cost} audit tokens have been paid to <@${targetId}> as false accusation damages.`
          }
        });
      }
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId.startsWith('cheat_match_prompt:')) {
    const fixtureId = customId.split(':')[1];
    return sendJson(res, {
      type: R.MESSAGE,
      data: {
        flags: FLAGS.EPHEMERAL,
        content: `⚡  **Illicit Cheat Deck**\nSelect a hack to run on this match:`,
        components: [{
          type: 1,
          components: [{
            type: 3,
            custom_id: `perform_cheat_selection:${fixtureId}`,
            placeholder: 'Choose a database exploit...',
            options: [
              { label: 'Half-Time Pivot (Swap predictions) - Cost: 40🪙', value: 'pivot', emoji: { name: '🔄' } },
              { label: 'Ghost Wager (Wager phantom bank credit) - Cost: 30🪙', value: 'ghost', emoji: { name: '👻' } },
              { label: 'Sabotage Opponent Wager - Cost: 50🪙', value: 'sabotage', emoji: { name: '💥' } }
            ]
          }]
        }]
      }
    });
  }

  if (customId.startsWith('perform_cheat_selection:')) {
    const fixtureId = customId.split(':')[1];
    const chosenCheat = interaction.data.values[0];

    try {
      const dbUser = await getOrCreateUser(user);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const costMap = { pivot: 40, ghost: 30, sabotage: 50 };
      const rawCost = costMap[chosenCheat] || 50;
      const cost = userClass === 'rogue' ? Math.round(rawCost * 0.70) : rawCost;

      if (dbUser.tokens_balance < cost) {
        return sendJson(res, errorEmbed(`You need ${cost} tokens to run this hack (Balance: ${dbUser.tokens_balance}).`));
      }

      // Cheat 1 (Half-Time Pivot) eligibility verification (Odds check)
      if (chosenCheat === 'pivot') {
        const bet = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        if (!bet.data || bet.data.amount_wagered % 2 === 0) {
          return sendJson(res, errorEmbed('Pivot locked! You must have wagered an odd number of tokens initially to prepare a half-time shift.'));
        }
      }

      if (chosenCheat === 'sabotage') {
        const bets = await supabase.from('bets').select('user_id').eq('fixture_id', fixtureId);
        if (!bets.data || bets.data.length <= 1) {
          return sendJson(res, errorEmbed('No other players are betting on this match to sabotage.'));
        }
        const targets = bets.data.filter(b => b.user_id !== user.id).map(b => ({
          label: `Target ID: ${b.user_id.substring(0, 15)}...`,
          value: `${b.user_id}:${fixtureId}`
        }));
        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `⚡  **Select Sabotage Target**\nSelect a victim on this match to alter their prediction wager by 50 tokens:`,
            components: [{
              type: 1,
              components: [{
                type: 3,
                custom_id: 'execute_sabotage_select',
                placeholder: 'Select victim...',
                options: targets
              }]
            }]
          }
        });
      }

      // Execute Immediate Cheats (Pivot & Ghost)
      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);
      await setConfigValue(`cheat:${user.id}:${fixtureId}`, chosenCheat);

      if (chosenCheat === 'pivot') {
        const bet = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        const nextTeam = bet.data.team_picked === 'home' ? 'away' : 'home';
        await supabase.from('bets').update({ team_picked: nextTeam }).eq('user_id', user.id).eq('fixture_id', fixtureId);
        await refreshPanel();
        return sendJson(res, { type: R.MESSAGE, data: { flags: FLAGS.EPHEMERAL, content: `🔄  **Exploit Executed!** Your wager has been fully shifted to **${nextTeam.toUpperCase()}**.` } });
      }

      if (chosenCheat === 'ghost') {
        const targetClue = Math.random() > 0.5 ? 'clueA' : 'clueC';
        if (targetClue === 'clueA') {
          // Public Ledger Corruption marker (leaderboard ~)
          await setConfigValue(`ledger_corrupted:${user.id}`, 'true');
        } else {
          // Public channel scrambled alert broadcast
          const channelConfig = await getPanelMessage();
          if (channelConfig) {
            await axios.post(`https://discord.com/api/v10/channels/${channelConfig.channelId}/messages`, {
              content: `⚠️  **[BANK AUDIT]** Unverified token injection detected from user: \`${user.username.substring(0, 2)}***${user.username.slice(-2)}\``
            }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
          }
        }
        return sendJson(res, { type: R.MESSAGE, data: { flags: FLAGS.EPHEMERAL, content: '👻  **Ghost Exploit Executed!** 150 phantom tokens have been injected on credit for your next bet.' } });
      }
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'execute_sabotage_select') {
    const [targetId, fixtureId] = interaction.data.values[0].split(':');
    try {
      const dbUser = await getOrCreateUser(user);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'rogue' ? 35 : 50;

      const targetClass = await getConfigValue(`class:${targetId}`);
      if (targetClass === 'auditor') {
        return sendJson(res, errorEmbed('Sabotage Blocked! Your target belongs to the Auditor class and is immune to system interference.'));
      }

      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);
      await setConfigValue(`cheat:${user.id}:${fixtureId}`, 'sabotage');

      // Shift target bet by 50 tokens
      const targetBet = await supabase.from('bets').select('*').eq('user_id', targetId).eq('fixture_id', fixtureId).single();
      const currentWager = targetBet.data?.amount_wagered || 0;
      const adjustment = Math.random() > 0.5 ? 50 : -50;
      await supabase.from('bets').update({ amount_wagered: Math.max(0, currentWager + adjustment) }).eq('user_id', targetId).eq('fixture_id', fixtureId);

      // DM victim with Class Hint
      try {
        const chan = await axios.post('https://discord.com/api/v10/users/@me/channels', { recipient_id: targetId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
        await axios.post(`https://discord.com/api/v10/channels/${chan.data.id}/messages`, {
          content: `⚠️  **System Alert:** Your active wager has been sabotaged and shifted by ${adjustment} tokens! The intruder was carrying an \`${userClass.toUpperCase()}\` class security card.`
        }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
      } catch (dmErr) {
        console.warn('Could not deliver sabotage DM alert:', dmErr.message);
      }

      await refreshPanel();
      return sendJson(res, { type: R.MESSAGE, data: { flags: FLAGS.EPHEMERAL, content: `💥  **Sabotage Successful!** Target's bet wager altered by ${adjustment} tokens.` } });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'view_my_history') {
    try {
      const dbUser = await getOrCreateUser(user);
      const history = await getUserHistory(user.id);
      const activeBets = history.filter(b => !b.settled);
      const pastBets = history.filter(b => b.settled);
      const profile = await buildProfileEmbed(dbUser, activeBets, pastBets);

      return sendJson(res, {
        type: R.MESSAGE,
        data: { flags: FLAGS.EPHEMERAL, embeds: [profile.embeds[0]], components: profile.components }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (customId === 'view_leaderboard') {
    try {
      const embed = await buildLeaderboardEmbed();
      return sendJson(res, { type: R.MESSAGE, data: { flags: FLAGS.EPHEMERAL, embeds: [embed] } });
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
              name: '3️⃣  Free Votes & Limits',
              value: 'Wager **0 tokens** to cast a Free Vote. Correct predictions earn **+5 tokens**.\n\n⚠️ **Bet Limit:** Your maximum allowed wager on any single match is **30% of your total wealth** (balance + active bets) or **300 tokens**, whichever is **lower**.'
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

      // Crucial: Await panel refresh completely BEFORE returning response
      await refreshPanel();

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
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
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
module.exports.config = { api: { bodyParser: false } };