/**
 * web/api/cron/sync.js
 *
 * Vercel Cron Job — runs daily at 12:00 UTC (10pm AEST)
 * Syncs match fixtures from API-Football and refreshes the pinned panel.
 *
 * Configured in web/vercel.json:
 *   { "path": "/api/cron/sync", "schedule": "0 12 * * *" }
 *
 * Vercel secures cron requests by sending an Authorization header.
 * Set CRON_SECRET in your Vercel environment variables.
 */

require('dotenv').config();
const axios = require('axios');
const { syncFixtures } = require('../../src/footballApi');
const { getPanelMessage } = require('../../src/database');
const { buildMasterPanel } = require('../../src/panel');

const BOT_TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_CLIENT_ID;

module.exports = async function handler(req, res) {
  // Verify the request is from Vercel's cron scheduler
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[Cron] Daily sync triggered at ${new Date().toISOString()}`);

  const results = { sync: null, panelRefresh: false, error: null };

  // Step 1: Sync fixtures from API-Football
  try {
    results.sync = await syncFixtures();
    console.log(`[Cron] Sync: ${results.sync.message}`);
  } catch (err) {
    results.error = err.message;
    console.error('[Cron] Sync failed:', err.message);
  }

  // Step 2: Refresh the pinned Master Panel embed
  try {
    const config = await getPanelMessage();
    if (config) {
      const panelData = await buildMasterPanel();
      await axios.patch(
        `https://discord.com/api/v10/channels/${config.channelId}/messages/${config.messageId}`,
        panelData,
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      results.panelRefresh = true;
      console.log('[Cron] Panel refreshed successfully.');
    } else {
      console.warn('[Cron] No panel config found — run /setup-panel first.');
    }
  } catch (err) {
    console.error('[Cron] Panel refresh failed:', err.response?.data || err.message);
  }

  return res.json({
    ok: !results.error,
    timestamp: new Date().toISOString(),
    ...results
  });
};
