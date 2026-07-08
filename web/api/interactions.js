/**
 * web/api/interactions.js
 *
 * Vercel Serverless Function — Discord Webhook Interaction Handler
 * Upgraded to force class selection on next interaction, support the mutual Syndicate linking handshake,
 * process the new /top-secret command, and ensure all panel updates complete processing before serverless thread termination.
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
      const profile = await buildProfileEmbed({ user: dbUser, activeBets, pastBets });

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

  if (name === 'link-syndicate') {
    try {
      const partnerId = interaction.data.options?.find(o => o.name === 'partner')?.value;

      if (partnerId === user.id) {
        return sendJson(res, errorEmbed("You cannot establish a co-op alliance with yourself!"));
      }

      await setConfigValue(`link_request:${user.id}`, partnerId);

      const targetRequest = await getConfigValue(`link_request:${partnerId}`);

      if (targetRequest === user.id) {
        await setConfigValue(`partner:${user.id}`, partnerId);
        await setConfigValue(`partner:${partnerId}`, user.id);
        
        await setConfigValue(`link_request:${user.id}`, '');
        await setConfigValue(`link_request:${partnerId}`, '');

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            content: `🤝  **Syndicate Victory Pact Formed!**  🤝\n<@${user.id}> and <@${partnerId}> are now permanently linked partners! Run your profile menus to choose the **Syndicate Class** to finalize activation.`
          }
        });
      } else {
        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `✅  **Co-op Request Sent!**\n\nWaiting for <@${partnerId}> to execute \`/link-syndicate @${user.username}\` to complete the handshake connection.`
          }
        });
      }
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  if (name === 'top-secret') {
    return sendJson(res, {
      type: R.MESSAGE,
      data: {
        flags: FLAGS.EPHEMERAL,
        embeds: [{
          color: 0x9b59b6, // Purple
          title: '🕵️‍♂️ Classified Transmission: Illicit Cheat Deck',
          description: 'Below are the protocols and database vulnerabilities that can be exploited during the final tournament stages.\n\u200b',
          fields: [
            {
              name: '🔄 Cheat 1: The Half-Time Pivot (Cost: 40🪙)',
              value: '• **Trigger Requirement:** You must place a wager ending in an **ODD number** (e.g., 103, 51) *before* kickoff.\n• **The Hack:** During half-time, execute the hack to shift **100%** of your wager to the other team.\n• **Risk:** Competitors can run probes to audit and expose your late shift.'
            },
            {
              name: '👻 Cheat 2: The Ghost Wager (Cost: 30🪙)',
              value: '• **The Hack:** Sneak up to **150 fake tokens** on credit over your maximum allowed bet limit.\n• **Clues:** Generates a public ledger corruption `~` marker on the leaderboard or triggers a scrambled bank audit alert in the public chat.'
            },
            {
              name: '💥 Cheat 3: System Sabotage (Cost: 50🪙)',
              value: '• **The Hack:** Target any active bet on your match card and force-shift their prediction wager by **50 tokens**.\n• **Clues:** The victim receives a DM warning identifying your *Class* (e.g. Renegade, Oracle). They can cross-reference the public board to trace you.'
            },
            {
              name: '🚨 Penalty Matrix',
              value: 'If audited and caught by another player:\n• All siphoned/ghost tokens are deleted and shifted bets canceled.\n• You are fined up to **100 tokens** (50 for Tanks).\n• Your active win streak is wiped instantly!'
            }
          ],
          footer: { text: 'To perform these exploits, use the "Perform Hack" button on any Match Detail panel.' }
        }]
      }
    });
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

      return sendJson(res, {
        type: R.UPDATE_MESSAGE,
        data: {
          embeds: panel.embeds,
          components: panel.components
        }
      });
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

      return sendJson(res, {
        type: R.UPDATE_MESSAGE,
        data: {
          embeds: panel.embeds,
          components: panel.components
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

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
      
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: detail.embeds,
          components: detail.components
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed("```\n" + err.message + "\n```"));
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
      const profile = await buildProfileEmbed({ user: dbUser, activeBets, pastBets });

      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [profile.embeds[0]],
          components: profile.components
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed("```\n" + err.message + "\n```"));
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
        embeds: [
          {
            color: COLORS.gold,
            title: '📖  World Cup 2026: Official Rule Book  ·  Project Blue-Lock',
            description: 'Navigate through the standard and advanced mechanics for the knockout stage tournament.\n\u200b',
            fields: [
              {
                name: '1️⃣  Payout Calculations',
                value: 'Winners split the collective pool proportionally to their wagers:\n```\nPayout = (Boosted Pool ÷ Winning Tokens) × Your Bet + Base Reward\n```'
              },
              {
                name: '2️⃣  Underdog Multipliers',
                value: '```\n> 80% vote share  →  1.0x  (heavy favourite)\n50–80%           →  1.0x  (standard split)\n20–50%           →  1.10x ⬆  (mild underdog)\n< 20%            →  1.20x  🔥 (miracle jackpot)\n```'
              },
              {
                name: '3️⃣  Faction Factions (Classes)',
                value: '🧬 **Oracle:** Toggles Streak Shield. Win bonus is +25 tokens (+15 when shielded).\n' +
                       '🏴‍☠️ **Renegade:** Receives 2 underdog Golden Tickets (Double profit) instead of 1.\n' +
                       '🛡️ **Tank:** Automatically receive 35% insurance refund on bets >= 200 tokens. Caught cheating fines are halved.\n' +
                       '🤝 **Syndicate:** Cooperative victory pact. If either partner wins, both win the entire event! *(Requires linking first using `/link-syndicate`)*\n' +
                       '🔍 **Auditor:** Auditing competitors is 50% cheaper, gets 1.5x catch bounty, immune to sabotage.'
              },
              {
                name: '4️⃣  Catching Cheaters (Match Auditing)',
                value: 'Click **`Audit / Probe`** on any Match Detail Panel to investigate competitors betting on that match.\n' +
                       '• Cost: `30 tokens` (`15` for Auditors).\n' +
                       '• **Success:** Target is fined up to 100 tokens, and you win a **+150 token bounty**!\n' +
                       '• **Failure:** If target is innocent, your audit tokens are transferred to their wallet as damages.'
              },
              {
                name: '🎮 General Commands (FYI)',
                value: '• `/profile` - View token balance, predictions history, streaks, and select Class.\n' +
                       '• `/leaderboard` - Public leaderboard with active Classes and Streaks.\n' +
                       '• `/link-syndicate @User` - Link with co-op partner (Syndicate class only).\n' +
                       '• `/top-secret` - Classified hacking logs.'
              }
            ],
            footer: { text: '💡 To view the hidden cheats deck, execute /top-secret.' }
          }
        ]
      }
    });
  }

  // Handle Class Role Selection Component
  if (customId === 'select_class_role') {
    const chosenClass = interaction.data.values[0];
    try {
      if (chosenClass === 'syndicate') {
        const partner = await getConfigValue(`partner:${user.id}`);
        if (!partner || partner === 'pending') {
          return sendJson(res, errorEmbed(
            "❌  **Selection Blocked!**\n\n" +
            "To select the Syndicate class, you must first establish a mutual co-op link with another player.\n\n" +
            "1. Run `/link-syndicate @User` to link with your partner.\n" +
            "2. Have your partner run `/link-syndicate @YourName` to accept.\n" +
            "3. Once linked, you can select the Syndicate class!"
          ));
        }
      }

      await setConfigValue(`class:${user.id}`, chosenClass);
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          content: `🔮  **Class chosen successfully!** Your class has been set to: **${chosenClass.toUpperCase()}**.`
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  // Handle Oracle Toggle Component
  if (customId === 'toggle_oracle_shield') {
    try {
      const current = await getConfigValue(`oracle_shield:${user.id}`) || 'off';
      const next = current === 'on' ? 'off' : 'on';
      await setConfigValue(`oracle_shield:${user.id}`, next);
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          content: `🔮  **Oracle Streak Shield** has been toggled: **${next.toUpperCase()}**!`
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  // Handle Apply Golden Ticket Component
  if (customId.startsWith('apply_ticket:')) {
    const fixtureId = customId.split(':')[1];
    try {
      const userClass = await getConfigValue(`class:${user.id}`);
      const rawTickets = await supabase.from('system_config').select('key').like('key', `ticket_used:${user.id}:%`);
      const ticketsUsed = rawTickets.data?.length || 0;
      const maxTickets = userClass === 'renegade' ? 2 : 1;

      if (ticketsUsed >= maxTickets) {
        return sendJson(res, errorEmbed(`Failed! You have no Golden Tickets remaining (Used: ${ticketsUsed}/${maxTickets}).`));
      }

      await setConfigValue(`ticket_used:${user.id}:${fixtureId}`, 'true');
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          content: `🎟️  **Golden Ticket Applied!** Your profit on match \`${fixtureId}\` will be doubled if correct.`
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  // Handle Local Match Audit Trigger Component
  if (customId.startsWith('audit_match_prompt:')) {
    const fixtureId = customId.split(':')[1];
    try {
      const bets = await supabase.from('bets').select('user_id').eq('fixture_id', fixtureId);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'auditor' ? 15 : 30;

      if (!bets.data || bets.data.length <= 1) {
        return sendJson(res, errorEmbed('No other players have placed predictions on this match yet.'));
      }

      const options = bets.data.filter(b => b.user_id !== user.id).map(b => ({
        label: `Audit Player ID: ${b.user_id.substring(0, 15)}...`,
        value: `${b.user_id}:${fixtureId}`
      }));

      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          content: `🔍  **Match Security Core**\nCost: \`${cost} tokens\`. Select a competitor to audit on this match:`,
          components: [{
            type: 1,
            components: [{
              type: 3,
              custom_id: 'perform_user_audit',
              placeholder: 'Select a target...',
              options: options
            }]
          }]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  // Handle Execution of User Investigation Component
  if (customId === 'perform_user_audit') {
    const [targetId, fixtureId] = interaction.data.values[0].split(':');
    try {
      const dbUser = await getOrCreateUser(user);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'auditor' ? 15 : 30;

      if (dbUser.tokens_balance < cost) {
        return sendJson(res, errorEmbed(`Insufficient tokens. Audit costs ${cost} (Balance: ${dbUser.tokens_balance}).`));
      }

      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);

      const cheatUsed = await getConfigValue(`cheat:${targetId}:${fixtureId}`);
      if (cheatUsed) {
        const targetClass = await getConfigValue(`class:${targetId}`);
        const fine = targetClass === 'tank' ? 50 : 100;

        const targetUser = await supabase.from('users').select('tokens_balance').eq('discord_id', targetId).single();
        const nextBal = Math.max(0, (targetUser.data?.tokens_balance || 0) - fine);

        await supabase.from('users').update({ tokens_balance: nextBal }).eq('discord_id', targetId);
        await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost + 150 }).eq('discord_id', user.id);
        await setConfigValue(`cheat:${targetId}:${fixtureId}`, ''); // Clear the cheat record

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            content: `🚨  **WHISTLEBLOWER BREACH**  🚨\n\n<@${user.id}> caught <@${targetId}> utilizing forbidden database cheats on match \`${fixtureId}\`!\n• <@${targetId}> has been fined **${fine} tokens**.\n• <@${user.id}> has received a **+150 token Whistleblower Bounty**!`
          }
        });
      } else {
        const targetUser = await supabase.from('users').select('tokens_balance').eq('discord_id', targetId).single();
        const nextBal = (targetUser.data?.tokens_balance || 0) + cost;
        await supabase.from('users').update({ tokens_balance: nextBal }).eq('discord_id', targetId);

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `🛡️  **Investigation Clean.** Target is innocent. Your ${cost} tokens have been paid to <@${targetId}> as false accusation damages.`
          }
        });
      }
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  // Handle Cheat Initialization Component
  if (customId.startsWith('cheat_match_prompt:')) {
    const fixtureId = customId.split(':')[1];
    return sendJson(res, {
      type: R.MESSAGE,
      data: {
        flags: FLAGS.EPHEMERAL,
        content: `⚡  **Active Exploit Terminal**\nSelect a database vulnerability to run on match \`${fixtureId}\`:`,
        components: [{
          type: 1,
          components: [{
            type: 3,
            custom_id: `perform_cheat_selection:${fixtureId}`,
            placeholder: 'Choose exploit...',
            options: [
              { label: 'Half-Time Pivot (100% Bet shift) - Cost: 40🪙', value: 'pivot', emoji: { name: '🔄' } },
              { label: 'Ghost Wager (Borrow up to 150 fake tokens) - Cost: 30🪙', value: 'ghost', emoji: { name: '👻' } },
              { label: 'Sabotage Opponent Prediction (Alters bet) - Cost: 50🪙', value: 'sabotage', emoji: { name: '💥' } }
            ]
          }]
        }]
      }
    });
  }

  // Handle Choosing Specific Exploit Component
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
        return sendJson(res, errorEmbed(`Insufficient tokens! Exploiting this module costs ${cost} (Wallet: ${dbUser.tokens_balance}).`));
      }

      if (chosenCheat === 'pivot') {
        const bet = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        if (!bet.data || bet.data.amount_wagered % 2 === 0) {
          return sendJson(res, errorEmbed('Exploit rejected! You must have wagers ending in an ODD integer locked in before kickoff to prepare a Half-Time Pivot.'));
        }
      }

      if (chosenCheat === 'sabotage') {
        const bets = await supabase.from('bets').select('user_id').eq('fixture_id', fixtureId);
        const targets = bets.data ? bets.data.filter(b => b.user_id !== user.id) : [];
        if (targets.length === 0) {
          return sendJson(res, errorEmbed('No other targets have wagered on this match.'));
        }

        const options = targets.map(b => ({
          label: `Target ID: ${b.user_id.substring(0, 15)}...`,
          value: `${b.user_id}:${fixtureId}`
        }));

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `⚡  **Select Sabotage Target**\nSelect a victim to force shift their wager:`,
            components: [{
              type: 1,
              components: [{
                type: 3,
                custom_id: 'execute_sabotage_select',
                placeholder: 'Select a competitor...',
                options: options
              }]
            }]
          }
        });
      }

      // Execute Ghost / Pivot
      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);
      await setConfigValue(`cheat:${user.id}:${fixtureId}`, chosenCheat);

      if (chosenCheat === 'pivot') {
        const bet = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        const next = bet.data.team_picked === 'home' ? 'away' : 'home';
        await supabase.from('bets').update({ team_picked: next }).eq('user_id', user.id).eq('fixture_id', fixtureId);
        
        await refreshPanel();
        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `🔄  **Exploit Completed!** Your active wager has been completely shifted to: **${next.toUpperCase()}**.`
          }
        });
      }

      if (chosenCheat === 'ghost') {
        const clue = Math.random() > 0.5 ? 'clueA' : 'clueC';
        if (clue === 'clueA') {
          await setConfigValue(`ledger_corrupted:${user.id}`, 'true');
        } else {
          const config = await getPanelMessage();
          if (config) {
            await axios.post(`https://discord.com/api/v10/channels/${config.channelId}/messages`, {
              content: `⚠️  **[BANK SECURITY WARNING]** Unverified token activity detected in server. Account masked ending with: \`***${user.username.slice(-3)}\``
            }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
          }
        }
        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: '👻  **Ghost Exploit Active!** Injected 150 phantom tokens on credit.'
          }
        });
      }
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  // Handle Execute Sabotage Component
  if (customId === 'execute_sabotage_select') {
    const [targetId, fixtureId] = interaction.data.values[0].split(':');
    try {
      const dbUser = await getOrCreateUser(user);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'rogue' ? 35 : 50;

      const targetClass = await getConfigValue(`class:${targetId}`);
      if (targetClass === 'auditor') {
        return sendJson(res, errorEmbed('System Error! Victim class "Auditor" is immune to system interference.'));
      }

      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);
      await setConfigValue(`cheat:${user.id}:${fixtureId}`, 'sabotage');

      const targetBet = await supabase.from('bets').select('*').eq('user_id', targetId).eq('fixture_id', fixtureId).single();
      const current = targetBet.data?.amount_wagered || 0;
      const change = Math.random() > 0.5 ? 50 : -50;
      await supabase.from('bets').update({ amount_wagered: Math.max(0, current + change) }).eq('user_id', targetId).eq('fixture_id', fixtureId);

      // DM victim
      try {
        const ch = await axios.post('https://discord.com/api/v10/users/@me/channels', { recipient_id: targetId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
        await axios.post(`https://discord.com/api/v10/channels/${ch.data.id}/messages`, {
          content: `⚠️  **Security Alert:** Your active wager has been sabotaged and shifted by ${change} tokens! The intruder was carrying an \`${userClass.toUpperCase()}\` class security card.`
        }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
      } catch (dmErr) {
        console.warn('Could not DM user sabotage notice:', dmErr.message);
      }

      await refreshPanel();
      return sendJson(res, {
        type: R.MESSAGE,
        data: { flags: FLAGS.EPHEMERAL, content: `💥  **Sabotage active.** Target bet shifted by ${change} tokens.` }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
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