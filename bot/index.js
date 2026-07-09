/**
 * bot/index.js
 *
 * Persistent Gateway bot engine supporting JustRunMy.App (JRMA) deployment.
 * Connects directly using WebSockets, completely eliminating Cold Start latencies.
 * Includes an Express listener to fulfill JRMA container health checks and route webhooks.
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const express = require('express');

const { syncFixtures } = require('../web/src/footballApi');
const { buildMasterPanel, COLORS } = require('../web/src/panel');
const { getPanelMessage, setConfigValue, getConfigValue, supabase } = require('../web/src/database');

const interactionsHandler = require('../web/api/interactions');
const syncCronHandler = require('../web/api/cron/sync');

// 1. Initialize Discord Gateway client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`[JRMA Gateway Bot] Successfully logged in as ${client.user.tag}`);
  
  client.user.setActivity('World Cup Virtual Pool', { type: ActivityType.Competing });

  // Automated 60-Minute Local Sync and panel updater
  setInterval(async () => {
    console.log('[Automated Task] Triggering hourly match sync...');
    try {
      await syncFixtures();
      const config = await getPanelMessage();
      if (config) {
        const panelData = await buildMasterPanel();
        const chan = await client.channels.fetch(config.channelId);
        const msg = await chan.messages.fetch(config.messageId);
        await msg.edit(panelData);
        console.log('[Automated Task] Hourly Sync and Pinned panel updated successfully.');
      }
    } catch (err) {
      console.error('[Automated Task Sync Error]:', err.message);
    }
  }, 1000 * 60 * 60); // 60 minutes
});

// "Top Secret" Chat Message Event Listener (Delivered securely to private DM)
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase().trim() === 'top secret') {
    try {
      const cheatExplainEmbed = {
        color: 0x9b59b6,
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
      };

      await message.author.send({ embeds: [cheatExplainEmbed] });
      
      if (message.deletable) {
        await message.delete();
      }
    } catch (err) {
      console.warn(`Could not deliver top secret DM to ${message.author.tag}:`, err.message);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

// 2. Initialize Express Web Server (Binds to process.env.PORT to satisfy JRMA platform health checks)
const app = express();
const PORT = process.env.PORT || 3000;

app.use('/api/interactions', express.raw({ type: '*/*' }));
app.use(express.json());

app.post('/api/interactions', (req, res) => {
  interactionsHandler(req, res);
});

app.get('/api/cron/sync', (req, res) => {
  syncCronHandler(req, res);
});

app.get('/', (req, res) => {
  res.send('[JRMA] Persistent Gateway Bot is active and running.');
});

app.listen(PORT, () => {
  console.log(`[JRMA Express Web Server] Successfully listening on port ${PORT}`);
});