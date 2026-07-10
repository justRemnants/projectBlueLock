/**
 * web/api/interactions.js
 *
 * Vercel Serverless Function — Discord Webhook Interaction Handler
 * Optimized for direct local execution on Vercel with zero database overhead on component updates.
 * Upgraded with buffer-safe stream processing, manual Syndicate validations, and 3-stage Golden Ticket toggles.
 */

require('dotenv').config();
const { verifyKey } = require('discord-interactions');
const axios = require('axios');

const {
  getOrCreateUser, getActiveMatches,
  calculateEstimatedEarnings, placeBet,
  getUserHistory, savePanelMessage, getPanelMessage, supabase,
  getConfigValue, setConfigValue, getUserStreak, getSpyMetric
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

/**
 * Robust raw body extractor that handles both raw streams (Vercel) and pre-buffered bodies (JRMA Express)
 */
function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    return Promise.resolve(Buffer.from(req.body, 'utf-8'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

  // Batch-fetch all class, streak, and ledger corruption keys in parallel
  const discordIds = users.map(u => u.discord_id);
  const classKeys = discordIds.map(id => `class:${id}`);
  const corruptionKeys = discordIds.map(id => `ledger_corrupted:${id}`);
  const allKeys = [...classKeys, ...corruptionKeys];

  const [configRows, streakResults] = await Promise.all([
    supabase.from('system_config').select('key, value').in('key', allKeys),
    Promise.all(discordIds.map(id => getUserStreak(id)))
  ]);

  const classMap = {};
  const corruptionMap = {};
  for (const row of (configRows.data || [])) {
    if (row.key.startsWith('class:')) {
      const id = row.key.replace('class:', '');
      classMap[id] = row.value || 'None';
    } else if (row.key.startsWith('ledger_corrupted:')) {
      const id = row.key.replace('ledger_corrupted:', '');
      corruptionMap[id] = row.value === 'true';
    }
  }

  const lines = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i+1}\``;
    const name = u.display_name || u.username;
    const uClass = (classMap[u.discord_id] || 'None');
    const streak = streakResults[i] || 0;
    const streakIndicator = streak >= 2 ? ` 🔥 x${streak}` : '';
    const corruptionSuffix = corruptionMap[u.discord_id] ? ' `~`' : '';
    lines.push(`${medal} **${name}${corruptionSuffix}** (${uClass.toUpperCase()}${streakIndicator}) · \`${fmt(u.tokens_balance)} tokens\``);
  }

  return {
    color: COLORS.gold,
    title: '🏆  Leaderboard Standings  •  Project Blue-Lock',
    description: lines.join('\n') || '*No registered competitors yet.*',
    timestamp: new Date().toISOString()
  };
}

function getStage(kickoffStr) {
  const date = new Date(kickoffStr);
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  if (month === 7) {
    if (day <= 11) return 'qf';
    if (day <= 14) return 'sf';
    return 'gf';
  }
  return 'qf';
}

const T = { PING: 1, COMMAND: 2, COMPONENT: 3, MODAL_SUBMIT: 5 };
const R = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7, MODAL: 9 };
const FLAGS = { EPHEMERAL: 64 };

async function handleCommand(interaction, res) {
  const name = interaction.data.name;
  const user = interaction.member?.user || interaction.user;
  const channelId = interaction.channel_id;

  if (name === 'panel' || name === 'setup-panel') {
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

  if (name === 'sync' || name === 'sync-matches') {
    const useMock = interaction.data.options?.find(o => o.name === 'mock')?.value ?? false;
    try {
      const result = useMock ? await syncMockFixtures() : await syncFixtures();
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

  if (name === 'check-api') {
    try {
      const status = await checkApiStatus();
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [{
            color: status.ok ? COLORS.green : COLORS.red,
            title: '📡  Football-Data.org API Status',
            description: status.message,
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
      const partnerRequest = await getConfigValue(`link_request:${partnerId}`);

      if (partnerRequest === user.id) {
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
            content: `✅  **Co-op Request Sent!** Waiting for <@${partnerId}> to execute \`/link-syndicate partner: @${user.username}\` to complete the handshake connection.`
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
          description: 'Below are the protocols and database vulnerabilities that can be exploited during the final tournament stages.\n\n' +
                      '🔒 **Instruction:** To execute these exploits, click the **stealth/blank button** (` ` with no text) located next to "Investigate" on any Match Detail panel.',
          fields: [
            {
              name: '🔄 Cheat 1: The Half-Time Pivot (Cost: 40🪙)',
              value: '• **Trigger Requirement:** You must place a wager ending in an **ODD number** (e.g., 103, 51) *before* kickoff.\n• **The Hack:** During half-time, execute the hack to shift **100%** of your wager to the other team.\n• **Risk:** Competitors can run investigations to audit and expose your late shift.'
            },
            {
              name: '👻 Cheat 2: The Ghost Wager (Cost: 30🪙)',
              value: '• **The Hack:** Sneak up to **150 fake tokens** on credit directly into your active wager.\n• **Clues:** Generates a public ledger corruption `~` marker on the leaderboard or triggers a scrambled bank audit alert in the public chat.'
            },
            {
              name: '💥 Cheat 3: System Sabotage (Cost: 20🪙)',
              value: '• **The Hack:** Target any active bet on your match card and force-shift their prediction wager by **50 tokens**.\n• **Clues:** The victim receives a DM warning identifying your *Class*.\n⚠️ **Warning:** Targeting an Investigator will fully expose your username identity to them!'
            },
            {
              name: '🚨 Penalty Matrix',
              value: 'If investigated and caught by another player:\n• All siphoned/ghost tokens are deleted and shifted bets canceled.\n• You are fined up to **30 tokens** (15 for Tanks).\n• Your active win streak is wiped instantly!'
            }
          ],
          footer: { text: 'To perform these exploits, use the blank button on any Match Detail panel.' }
        }]
      }
    });
  }

  if (name === 'ping') {
    const isVercel = process.env.VERCEL === '1';
    const hostText = isVercel ? 'Vercel Serverless' : 'JustRunMy.App (Persistent VM)';
    const startDB = Date.now();
    
    try {
      await supabase.from('system_config').select('value').eq('key', 'panel_channel_id').single();
      const dbDuration = Date.now() - startDB;
      
      return sendJson(res, {
        type: R.MESSAGE,
        data: {
          flags: FLAGS.EPHEMERAL,
          embeds: [{
            color: COLORS.green,
            title: '🏓  Routing Pong Diagnostics',
            description: `⚡  **Active Webhook Host:** \`${hostText}\`\n` +
                        `**Supabase Connection Database Ping:** \`${dbDuration}ms\``
          }]
        }
      });
    } catch (err) {
      return sendJson(res, errorEmbed(err.message));
    }
  }

  // Fallback for unhandled commands to prevent timeouts on Discord
  return sendJson(res, errorEmbed(`The command "/${name}" is not implemented or supported on this host.`));
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

  // Blazing Fast Selection (<150ms): Zero blocking REST/PATCH calls, responds instantly with direct Ephemeral layout
  if (customId === 'select_match') {
    const fixtureId = interaction.data.values[0];
    if (fixtureId === 'none') {
      return sendJson(res, { type: R.DEFERRED_UPDATE });
    }

    try {
      // 1. Fetch User & Match data concurrently (~150ms)
      const [dbUser, matches] = await Promise.all([
        getOrCreateUser(user),
        getActiveMatches()
      ]);
      
      const match = matches.find(m => m.fixture_id === fixtureId);
      if (!match) {
        return sendJson(res, errorEmbed('The selected match could not be found.'));
      }

      // 2. Assemble the detailed match panel layout (~150ms)
      const detail = await buildMatchDetail(match, dbUser);

      // 3. Reset the public dropdown instantly via REST API (~100ms)
      // Passing the exact same components causes Discord to clear the user's local visual selection.
      if (interaction.channel_id && interaction.message?.id) {
        axios.patch(
          `https://discord.com/api/v10/channels/${interaction.channel_id}/messages/${interaction.message.id}`,
          { components: interaction.message.components },
          { headers: { Authorization: `Bot ${BOT_TOKEN}` }, timeout: 4000 }
        ).catch(e => console.warn('Failed to clear dropdown:', e.message));
      }

      // 4. Return the Ephemeral Match Card directly in the HTTP Response
      return sendJson(res, {
        type: R.MESSAGE, // Type 4
        data: {
          flags: FLAGS.EPHEMERAL, // 64
          embeds: detail.embeds,
          components: detail.components
        }
      });
    } catch (err) {
      console.error('[Select Match Error]:', err.message);
      return sendJson(res, errorEmbed(`Failed to load match detail: ${err.message}`));
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
          label: 'Wager amount (Minimum 50 tokens)',
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
            description: '\u200b',
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
                name: '3️⃣  Golden Tickets 🎟️',
                value: 'Activating a Golden Ticket does not cost any extra tokens, but **doubles your net profit** on that bet if your prediction is correct. Standard classes receive **1 ticket**; Renegades receive **2 tickets** (restricted strictly to underdog matches).'
              },
              {
                name: '4️⃣  Faction Classes (Classes)',
                value: '🧬 **Oracle:** Has 1 streak shield per stage and gets a flat 25 token boost to base payment (15 when shield is active).\n' +
                       '🏴‍☠️ **Renegade:** Receives two golden tickets rather than one, however they can only be used when betting on an underdog.\n' +
                       '🛡️ **Tank:** Automatically receives a 35% refund on lost bets over 200 tokens and any fines are halved.\n' +
                       '🤝 **Syndicate:** Plays with a partner. Streak bonuses are shared and if one player wins the event, they both share the victory. 15% more winnings from bets, however a 20 token fee for losses.\n' +
                       '🔍 **Investigator:** Investigating others is 50% cheaper, plus receives immunity to sabotages.'
              },
              {
                name: '5️⃣  Investigating Cheaters (Match Auditing)',
                value: 'Click **`Investigate`** on any Match Detail Panel to audit competitors.\n' +
                       '• Cost: `30 tokens` (`15` for Investigators).\n' +
                       '• **Success:** Target is fined **30 tokens**, and you win **75 + cost tokens** as a bounty!\n' +
                       '• **Failure:** If the target is innocent, they receive 10 tokens.'
              },
              {
                name: '☢️  NUCLEAR MODE PROTOCOLS',
                value: '• **No Free Votes:** Free (0-token) predictions are completely disabled.\n' +
                       '• **Minimum Bet:** The minimum allowed wager is **50 tokens**.\n' +
                       '• **Uncapped Wagers:** The standard 30% wealth cap and 300 token limit are **completely deactivated**! Bet up to your entire wallet balance.\n' +
                       '• **Pool Share Restriction:** Correct predictions on wagers under 100 tokens (50-99) only return your bet back plus your flat base reward, with **0% share of the winning dividend pool**.'
              }
            ],
            footer: { text: 'Something /top-secret is going on...' }
          }
        ]
      }
    });
  }

  if (customId === 'select_class_role') {
    const chosenClass = interaction.data.values[0];
    try {
      if (chosenClass === 'syndicate') {
        const partner = await getConfigValue(`partner:${user.id}`);
        if (!partner || partner === 'pending' || partner === 'Unlinked') {
          return sendJson(res, errorEmbed(
            "❌  **Selection Blocked!**\n\n" +
            "To select the Syndicate class, you must first establish a mutual co-op link with another player.\n\n" +
            "1. Run `/link-syndicate` selecting your partner to send a link request.\n" +
            "2. Have your partner run `/link-syndicate` selecting you to accept.\n" +
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

  if (customId.startsWith('apply_ticket:')) {
    const fixtureId = customId.split(':')[1];
    try {
      const match = (await getActiveMatches()).find(m => m.fixture_id === fixtureId);
      if (!match) return sendJson(res, errorEmbed('Match not found.'));
      if (new Date() >= new Date(match.kickoff_time)) {
        return sendJson(res, errorEmbed('Failed! This match has already kicked off and golden tickets are locked.'));
      }

      const activeState = await getConfigValue(`ticket_used:${user.id}:${fixtureId}`);
      if (activeState === 'true') {
        await setConfigValue(`ticket_used:${user.id}:${fixtureId}`, '');
        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: '🎟️  **Golden Ticket Cancelled!** The ticket has been safely returned to your inventory.'
          }
        });
      }

      const userClass = await getConfigValue(`class:${user.id}`);
      const currentStage = getStage(match.kickoff_time);

      const rawTickets = await supabase.from('system_config').select('key').like('key', `ticket_used:${user.id}:%`);
      const activeUsedFixtureIds = (rawTickets.data || [])
        .map(t => t.key.split(':').pop())
        .filter(fid => fid && fid !== fixtureId);

      let ticketsUsedInCurrentStage = 0;
      if (activeUsedFixtureIds.length > 0) {
        const matches = await getActiveMatches();
        for (const fid of activeUsedFixtureIds) {
          const pastMatch = matches.find(m => m.fixture_id === fid);
          if (pastMatch && getStage(pastMatch.kickoff_time) === currentStage) {
            ticketsUsedInCurrentStage++;
          }
        }
      }

      const maxTickets = userClass === 'renegade' ? 2 : 1;
      if (ticketsUsedInCurrentStage >= maxTickets) {
        return sendJson(res, errorEmbed(`Failed! You have no Golden Tickets remaining for the ${currentStage.toUpperCase()} stage (Used: ${ticketsUsedInCurrentStage}/${maxTickets}).`));
      }

      if (userClass === 'renegade') {
        const spy = await getSpyMetric(fixtureId);
        const total = spy.totalVotes || 0;
        const bets = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        if (bets.data) {
          const pick = bets.data.team_picked;
          const share = total > 0 ? (spy[pick].votes / total) : 0.5;
          if (share >= 0.40) {
            return sendJson(res, errorEmbed('Failed! Renegades can only apply Golden Tickets on Underdogs (<40% vote share).'));
          }
        }
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

  if (customId.startsWith('audit_match_prompt:')) {
    const fixtureId = customId.split(':')[1];
    try {
      const bets = await supabase.from('bets').select('user_id').eq('fixture_id', fixtureId);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'investigator' ? 15 : 30;

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

  if (customId === 'perform_user_audit') {
    const [targetId, fixtureId] = interaction.data.values[0].split(':');
    try {
      const dbUser = await getOrCreateUser(user);
      const userClass = await getConfigValue(`class:${user.id}`) || 'None';
      const cost = userClass === 'investigator' ? 15 : 30;

      if (dbUser.tokens_balance < cost) {
        return sendJson(res, errorEmbed(`Insufficient tokens. Audit costs ${cost} (Balance: ${dbUser.tokens_balance}).`));
      }

      // Deduct investigation cost
      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);

      const cheatsUsedRaw = await getConfigValue(`cheat:${targetId}:${fixtureId}`) || '';
      const cheatsUsed = cheatsUsedRaw ? cheatsUsedRaw.split(',') : [];

      if (cheatsUsed.length > 0) {
        // Apply Fine (Tank gets a 50% discount on fines)
        const actualFine = 30;
        const targetClass = await getConfigValue(`class:${targetId}`);
        const fineApplied = targetClass === 'tank' ? 15 : actualFine;

        const targetUser = await supabase.from('users').select('tokens_balance').eq('discord_id', targetId).single();
        const nextBal = Math.max(0, (targetUser.data?.tokens_balance || 0) - fineApplied);
        await supabase.from('users').update({ tokens_balance: nextBal }).eq('discord_id', targetId);

        // Wipe target's active win streak instantly (Ignore all past wins settled before this date)
        await setConfigValue(`streak_reset_date:${targetId}`, new Date().toISOString());

        let ghostReverted = false;
        let pivotReverted = false;
        let sabotageReverted = false;

        // Perform exact rollback based on the comma-separated cheat list
        for (const cheat of cheatsUsed) {
          if (cheat === 'ghost' || cheat === 'pivot') {
            // Cancel/void the entire bet (deletes row)
            await supabase.from('bets').delete().eq('user_id', targetId).eq('fixture_id', fixtureId);
            if (cheat === 'ghost') ghostReverted = true;
            if (cheat === 'pivot') {
              pivotReverted = true;
              // Refund their original non-siphoned tokens to prevent unfair complete wallet loss on standard pivot wagers
              const originalWager = await getConfigValue(`original_wager:${targetId}:${fixtureId}`) || '0';
              const refundAmount = parseInt(originalWager, 10);
              if (refundAmount > 0) {
                const targetFresh = await supabase.from('users').select('tokens_balance').eq('discord_id', targetId).single();
                await supabase.from('users').update({ tokens_balance: (targetFresh.data?.tokens_balance || 0) + refundAmount }).eq('discord_id', targetId);
              }
            }
          }

          if (cheat === 'sabotage') {
            // Retrieve victim ID and exact token shift value to perform precise mathematical reversal
            const sabotageMeta = await getConfigValue(`sabotaged_victim:${targetId}:${fixtureId}`);
            if (sabotageMeta) {
              const [victimId, shiftAmountRaw] = sabotageMeta.split(':');
              const shiftAmount = parseInt(shiftAmountRaw, 10);
              
              const victimBet = await supabase.from('bets').select('*').eq('user_id', victimId).eq('fixture_id', fixtureId).single();
              if (victimBet.data) {
                // Reverse the sabotage token alteration
                const nextWager = Math.max(0, victimBet.data.amount_wagered - shiftAmount);
                await supabase.from('bets').update({ amount_wagered: nextWager }).eq('user_id', victimId).eq('fixture_id', fixtureId);
                sabotageReverted = true;
              }
              // Clean up metadata
              await setConfigValue(`sabotaged_victim:${targetId}:${fixtureId}`, '');
            }
          }
        }

        // Clean up the target's cheat configuration keys completely
        await setConfigValue(`cheat:${targetId}:${fixtureId}`, '');
        await setConfigValue(`ledger_corrupted:${targetId}`, '');

        // Reward Investigator with Bounty (75 tokens + full refund of cost)
        const bounty = 75 + cost;
        await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost + bounty }).eq('discord_id', user.id);

        // Build a detailed public whistleblower alert
        const reportParts = [];
        if (ghostReverted) reportParts.push('• 👻 **Ghost Wager** deleted, and siphoned tokens destroyed!');
        if (pivotReverted) reportParts.push('• 🔄 **HT Pivot** canceled, and bet voided!');
        if (sabotageReverted) reportParts.push('• 💥 **System Sabotage** completely rolled back and victim bet restored!');

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            content: `🚨  **WHISTLEBLOWER BREACH DETECTED**  🚨\n\n<@${user.id}> caught <@${targetId}> utilizing forbidden database exploits on match \`${fixtureId}\`!\n\n` +
                     `**ROLLBACK LOGS:**\n${reportParts.join('\n')}\n` +
                     `• <@${targetId}> has been fined **${fineApplied} tokens** and their win streak wiped!\n` +
                     `• <@${user.id}> has been awarded a **+${bounty} token Bounty Reward**!`
          }
        });
      } else {
        // Target is innocent
        const targetUser = await supabase.from('users').select('tokens_balance').eq('discord_id', targetId).single();
        const nextBal = (targetUser.data?.tokens_balance || 0) + 10;
        await supabase.from('users').update({ tokens_balance: nextBal }).eq('discord_id', targetId);

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `🛡️  **Investigation Clean.** Target is innocent. Your ${cost} tokens have been processed. Target received +10 tokens compensation.`
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
        content: `⚡  **Active Exploit Terminal**\nSelect a database vulnerability to run on match \`${fixtureId}\`:\n\n*⚠️ Warning: Targets with the **Investigator** class will automatically expose your identity directly to their DMs!*`,
        components: [{
          type: 1,
          components: [{
            type: 3,
            custom_id: `perform_cheat_selection:${fixtureId}`,
            placeholder: 'Choose exploit...',
            options: [
              { label: 'Half-Time Pivot (100% Bet shift) - Cost: 40🪙', value: 'pivot', emoji: { name: '🔄' } },
              { label: 'Ghost Wager (+150 Tokens additions) - Cost: 30🪙', value: 'ghost', emoji: { name: '👻' } },
              { label: 'Sabotage Opponent Prediction (Alters bet) - Cost: 20🪙', value: 'sabotage', emoji: { name: '💥' } }
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
      const costMap = { pivot: 40, ghost: 30, sabotage: 20 };
      const rawCost = costMap[chosenCheat] || 20;
      const cost = userClass === 'rogue' ? Math.round(rawCost * 0.70) : rawCost;

      if (dbUser.tokens_balance < cost) {
        return sendJson(res, errorEmbed(`Insufficient tokens! Exploiting this module costs ${cost} (Wallet: ${dbUser.tokens_balance}).`));
      }

      // Check for already-used cheats to prevent stacking the same one
      const existingCheatsRaw = await getConfigValue(`cheat:${user.id}:${fixtureId}`) || '';
      const existingCheats = existingCheatsRaw ? existingCheatsRaw.split(',') : [];

      if (existingCheats.includes(chosenCheat)) {
        return sendJson(res, errorEmbed(`Exploit rejected! You have already executed the **${chosenCheat.toUpperCase()}** cheat on this match.`));
      }

      if (chosenCheat === 'pivot') {
        const bet = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        if (!bet.data) {
          return sendJson(res, errorEmbed('Exploit rejected! You must place an active bet before you can execute a pivot.'));
        }
        if (bet.data.amount_wagered % 2 === 0) {
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

      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);
      
      // Update cheats list
      existingCheats.push(chosenCheat);
      await setConfigValue(`cheat:${user.id}:${fixtureId}`, existingCheats.join(','));

      if (chosenCheat === 'pivot') {
        const bet = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        const next = bet.data.team_picked === 'home' ? 'away' : 'home';

        // Save original wager size to prevent complete balance loss upon investigation voiding
        await setConfigValue(`original_wager:${user.id}:${fixtureId}`, bet.data.amount_wagered.toString());

        await supabase.from('bets').update({ team_picked: next }).eq('user_id', user.id).eq('fixture_id', fixtureId);

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: `🔄  **Exploit Completed!** Your active wager has been completely shifted to: **${next.toUpperCase()}**.`
          }
        });
      }

      if (chosenCheat === 'ghost') {
        const bet = await supabase.from('bets').select('*').eq('user_id', user.id).eq('fixture_id', fixtureId).single();
        if (bet.data) {
          await supabase.from('bets').update({ amount_wagered: bet.data.amount_wagered + 150 }).eq('user_id', user.id).eq('fixture_id', fixtureId);
        }

        const clue = Math.random() > 0.5 ? 'clueA' : 'clueC';
        if (clue === 'clueA') {
          await setConfigValue(`ledger_corrupted:${user.id}`, 'true');
        } else {
          const config = await getPanelMessage();
          if (config) {
            const generalChannelId = await getConfigValue('general_channel_id');
            const targetChan = generalChannelId || config.channelId;

            // Approximate middle name segment extraction with minor index shifting (makes tracing ghost wagers dynamic and engaging)
            const len = user.username.length;
            let start = Math.floor(len / 2) - 1;
            const shift = Math.floor(Math.random() * 3) - 1; // Randomly shifts starting index by -1, 0, or +1
            start = Math.max(1, Math.min(len - 3, start + shift));
            const midSegment = user.username.substring(start, start + 2);
            const maskedName = `***${midSegment}***`;

            await axios.post(`https://discord.com/api/v10/channels/${targetChan}/messages`, {
              content: `⚠️  **[BANK SECURITY WARNING]** Unverified token activity detected in server. Account masked with approximate middle segment: \`${maskedName}\``
            }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
          }
        }

        return sendJson(res, {
          type: R.MESSAGE,
          data: {
            flags: FLAGS.EPHEMERAL,
            content: '👻  **Ghost Exploit Active!** Added 150 fake tokens directly to your active wager on credit.'
          }
        });
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
      const cost = userClass === 'rogue' ? 14 : 20;

      const targetClass = await getConfigValue(`class:${targetId}`);
      if (targetClass === 'investigator') {
        try {
          const ch = await axios.post('https://discord.com/api/v10/users/@me/channels', { recipient_id: targetId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
          await axios.post(`https://discord.com/api/v10/channels/${ch.data.id}/messages`, {
            content: `🛡️  **Firewall Detection:** <@${user.id}> (\`@${user.username}\`) attempted to sabotage your prediction on Match \`${fixtureId}\`, but your **Investigator Security Protocol** automatically blocked and identified them!`
          }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
        } catch (dmErr) {
          console.warn('Could not DM investigator alert:', dmErr.message);
        }

        return sendJson(res, errorEmbed('System Hack Blocked! Target is an Investigator. Your payload has failed and your username has been exposed to them!'));
      }

      // Check for already-used cheats to prevent stacking the same one
      const existingCheatsRaw = await getConfigValue(`cheat:${user.id}:${fixtureId}`) || '';
      const existingCheats = existingCheatsRaw ? existingCheatsRaw.split(',') : [];

      if (existingCheats.includes('sabotage')) {
        return sendJson(res, errorEmbed(`Exploit rejected! You have already executed the **SABOTAGE** cheat on this match.`));
      }

      await supabase.from('users').update({ tokens_balance: dbUser.tokens_balance - cost }).eq('discord_id', user.id);
      
      // Update cheats list
      existingCheats.push('sabotage');
      await setConfigValue(`cheat:${user.id}:${fixtureId}`, existingCheats.join(','));

      const targetBet = await supabase.from('bets').select('*').eq('user_id', targetId).eq('fixture_id', fixtureId).single();
      const current = targetBet.data?.amount_wagered || 0;
      const change = Math.random() > 0.5 ? 50 : -50;
      await supabase.from('bets').update({ amount_wagered: Math.max(0, current + change) }).eq('user_id', targetId).eq('fixture_id', fixtureId);

      // Save sabotage meta-details to allow precise manual or automated rollbacks
      await setConfigValue(`sabotaged_victim:${user.id}:${fixtureId}`, `${targetId}:${change}`);

      try {
        const ch = await axios.post('https://discord.com/api/v10/users/@me/channels', { recipient_id: targetId }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
        await axios.post(`https://discord.com/api/v10/channels/${ch.data.id}/messages`, {
          content: `⚠️  **Security Alert:** Your active wager has been sabotaged and shifted by ${change} tokens! The intruder was carrying an \`${userClass.toUpperCase()}\` class security card.`
        }, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
      } catch (dmErr) {
        console.warn('Could not DM user sabotage notice:', dmErr.message);
      }

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

    // Modal verification
    if (isNaN(amountWagered) || amountWagered < 50) {
      return sendJson(res, errorEmbed('Wager declined! **Nuclear Mode is active.** The minimum allowed wager is **50 tokens**, and Free Votes (0 tokens) are disabled.'));
    }

    try {
      // 1. Fetch User, History, and target Match concurrently to cut down latency (Fast ~150ms)
      const [dbUser, history, match] = await Promise.all([
        getOrCreateUser(user),
        getUserHistory(user.id),
        supabase.from('matches').select('*').eq('fixture_id', fixtureId).single().then(r => r.data)
      ]);

      if (!match) {
        return sendJson(res, errorEmbed('The selected match could not be found.'));
      }

      if (new Date() >= new Date(match.kickoff_time)) {
        return sendJson(res, errorEmbed('Wager declined! This match has already kicked off and predictions are locked.'));
      }

      // 2. Perform validations instantly using local pre-fetched data (0ms cost)
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

      // 3. Save bet and compute payout estimate concurrently (~200ms)
      const [result, estEarnings] = await Promise.all([
        placeBet(user.id, fixtureId, teamPicked, amountWagered),
        calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, user.id)
      ]);

      // 4. Return instant confirmation payload (Total execution time well under 500ms)
      return sendJson(res, {
        type: R.MESSAGE, // Type 4
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
      console.error('[Wager Modal Submit Error]:', err.message);
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