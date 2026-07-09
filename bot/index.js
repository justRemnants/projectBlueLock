/**
 * web/index.js
 * 
 * Express Host Server for executing interactions persistently on JustRunMy.App.
 * Keeps standard compatibility so you can roll back to serverless Vercel seamlessly at any time.
 */

require('dotenv').config();
const express = require('express');
const interactionHandler = require('./api/interactions');
const syncCronHandler = require('./api/cron/sync');

const app = express();
const PORT = process.env.PORT || 3000;

// Discord-interactions needs raw bodies to cryptographically verify signatures
app.use('/api/interactions', express.raw({ type: '*/*' }));
app.use(express.json());

app.post('/api/interactions', (req, res) => {
  // Directly passes req and res to the serverless Vercel module
  interactionHandler(req, res);
});

app.get('/api/cron/sync', (req, res) => {
  syncCronHandler(req, res);
});

app.listen(PORT, () => {
  console.log(`[JRMA Server] Project Blue-Lock bot server listening on port ${PORT}`);
});