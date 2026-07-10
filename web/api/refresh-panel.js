/**
 * web/api/refresh-panel.js
 *
 * Dedicated background endpoint triggered by Supabase Database Webhooks
 * to asynchronously refresh the pinned Master Panel without blocking user interactions.
 */

const { getPanelMessage } = require('../src/database');
const { buildMasterPanel } = require('../src/panel');
const axios = require('axios');

const BOT_TOKEN = process.env.DISCORD_TOKEN;

module.exports = async function handler(req, res) {
  console.log('[Background Refresh] Database state change detected, updating master panel...');
  
  try {
    const config = await getPanelMessage();
    if (!config) {
      console.warn('[Background Refresh Error] No active panel configuration found.');
      return res.status(404).json({ error: 'No active panel message found.' });
    }
    
    // Regenerate the master panel embed with updated odds & spy metrics
    const panelData = await buildMasterPanel();
    
    // Edit the message directly via Discord REST API
    await axios.patch(
      `https://discord.com/api/v10/channels/${config.channelId}/messages/${config.messageId}`,
      panelData,
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    
    console.log('[Background Refresh] Master Panel updated successfully.');
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Background Refresh Error]:', err.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
};