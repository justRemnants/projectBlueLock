/**
 * web/api/config.js
 * 
 * Vercel Serverless Function — Dynamically serves public configuration variables
 * (Supabase URL and public Anon Key) to the client on load, keeping HTML files free of keys.
 */

require('dotenv').config();

module.exports = async function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    discordClientId: process.env.DISCORD_CLIENT_ID
  }));
};