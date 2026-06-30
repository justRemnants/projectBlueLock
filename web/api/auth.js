/**
 * web/api/auth.js
 * 
 * Vercel Serverless Function — Handles Discord OAuth2 handshake, Supabase upserts,
 * and session state verification using standard Node.js crypto signatures.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { getOrCreateUser, supabase } = require('../src/database');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

// We use the Client Secret to securely sign and verify user session tokens
const SESSION_SECRET = CLIENT_SECRET || 'fallback-secure-random-secret-string';

/**
 * Native cryptographic token signing helper (stateless, JWT-like)
 */
function signToken(data, secret) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return `${payload}.${signature}`;
}

/**
 * Native cryptographic token verification helper
 */
function verifyToken(token, secret) {
  try {
    const [payload, signature] = token.split('.');
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    if (signature === expectedSignature) {
      return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    }
  } catch (e) {
    console.error('[Auth Secret Verification Error]', e.message);
  }
  return null;
}

function sendJson(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  // Parse payload body manually or via Vercel's default parser
  const body = req.body || {};
  const { code, token } = body;

  // ─── Scenario 1: Verify Existing Token (Auto-Login on Page Refresh) ─────────
  if (token) {
    const session = verifyToken(token, SESSION_SECRET);
    if (!session || !session.discord_id) {
      return sendJson(res, { error: 'Invalid or expired session token.' }, 401);
    }

    try {
      // Fetch fresh user profile details directly from the database
      const { data: dbUser, error } = await supabase
        .from('users')
        .select('*')
        .eq('discord_id', session.discord_id)
        .single();

      if (error || !dbUser) {
        return sendJson(res, { error: 'User profile not found in database.' }, 404);
      }

      return sendJson(res, { user: dbUser, token });
    } catch (err) {
      console.error('[Session Verification Error]:', err.message);
      return sendJson(res, { error: 'Internal server verification error.' }, 500);
    }
  }

  // ─── Scenario 2: Code Exchange Handshake (Initial Authentication) ──────────
  if (code) {
    // Dynamically construct the redirect URI based on the request's origin host
    const host = req.headers.host;
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/`;

    try {
      // Step A: Exchange authorization code for Discord access token
      const tokenResponse = await axios.post(
        'https://discord.com/api/v10/oauth2/token',
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: redirectUri
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const accessToken = tokenResponse.data.access_token;

      // Step B: Fetch the authenticated user's profile details from Discord
      const userResponse = await axios.get('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const discordUser = userResponse.data;

      // Step C: Upsert the user profile into Supabase (creates with 500 tokens if new)
      const dbUser = await getOrCreateUser(discordUser);

      // Step D: Create a signed session token
      const sessionToken = signToken({ discord_id: dbUser.discord_id }, SESSION_SECRET);

      return sendJson(res, {
        user: dbUser,
        token: sessionToken
      });
    } catch (err) {
      console.error('[OAuth Handshake Error]:', err.response?.data || err.message);
      return sendJson(res, { error: 'Authentication handshake failed.' }, 400);
    }
  }

  return sendJson(res, { error: 'Missing authorization code or session token.' }, 400);
};