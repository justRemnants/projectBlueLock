/**
 * web/scripts/request-admin-history.js
 * 
 * Local script to trigger the initial interactive admin history DM.
 */

require('dotenv').config({ path: '../bot/.env' }); // Reads local .env variables
const axios = require('axios');
const { buildAdminHistoryPage } = require('../src/panel');

const BOT_TOKEN = process.env.DISCORD_TOKEN;

// ───────────────────────────────────────────────────────────────────────────
// CONFIGURATION: Put your personal Discord User ID here!
// ───────────────────────────────────────────────────────────────────────────
const ADMIN_DISCORD_ID = "YOUR_PERSONAL_DISCORD_USER_ID_HERE"; // Right-click your name in Discord -> Copy User ID

async function triggerHistoryDM() {
  if (!BOT_TOKEN) {
    console.error('❌ DISCORD_TOKEN is missing from your environment.');
    return;
  }
  if (ADMIN_DISCORD_ID === "YOUR_PERSONAL_DISCORD_USER_ID_HERE") {
    console.error('❌ Please replace "YOUR_PERSONAL_DISCORD_USER_ID_HERE" with your actual Discord User ID.');
    return;
  }

  console.log(`🚀 Compiling Page 1 of the Admin History console for User ID: ${ADMIN_DISCORD_ID}...`);

  try {
    // 1. Compile Page 1 of the interactive history card
    const panel = await buildAdminHistoryPage(1, 'date_desc');

    // 2. Open a DM channel with you
    const channelRes = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: ADMIN_DISCORD_ID },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const channelId = channelRes.data.id;

    // 3. Post the interactive panel directly to your DMs
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      panel,
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log(`✅ Success! The interactive admin history console has been delivered to your Discord DMs.`);
  } catch (err) {
    console.error('❌ Failed to trigger DM:', err.response?.data || err.message);
  }
}

triggerHistoryDM();