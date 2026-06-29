/**
 * web/src/panel.js
 *
 * Builds all Discord embeds and component JSON for the bot.
 * Uses plain objects (no discord.js) so it works in serverless Vercel functions.
 */

const { getActiveMatches, getSpyMetric } = require('./database');

const COLORS = {
  blue:   0x1a6bff,
  green:  0x00cc66,
  red:    0xff3333,
  gold:   0xf1c40f,
  purple: 0x9b59b6,
  grey:   0x95a5a6
};

function fmt(n) {
  return Number(n).toLocaleString();
}

function progressBar(percent, len = 10) {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 100 * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

function getAustralianDayLabel(kickoffStr) {
  const opts = { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' };
  const fmt = new Intl.DateTimeFormat('en-CA', opts);
  const nowLabel = fmt.format(new Date());
  const tomorrowLabel = fmt.format(new Date(Date.now() + 86400000));
  const kickLabel = fmt.format(new Date(kickoffStr));
  if (kickLabel === nowLabel) return 'Today';
  if (kickLabel === tomorrowLabel) return 'Tomorrow';
  return null;
}

function embed({ color = COLORS.blue, title, description, fields = [], footer, thumbnail, timestamp = true }) {
  return {
    color,
    title,
    description,
    fields,
    ...(footer ? { footer: { text: footer } } : {}),
    ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
    ...(timestamp ? { timestamp: new Date().toISOString() } : {})
  };
}

function actionRow(components) {
  return { type: 1, components };
}

function selectMenu({ customId, placeholder, options, disabled = false }) {
  return {
    type: 3,
    custom_id: customId,
    placeholder,
    disabled,
    options: options.map(o => ({
      label: o.label,
      value: o.value,
      ...(o.description ? { description: o.description } : {}),
      ...(o.emoji ? { emoji: { name: o.emoji } } : {})
    }))
  };
}

function button({ customId, label, emoji, style = 2 }) {
  return {
    type: 2,
    custom_id: customId,
    label,
    style,
    ...(emoji ? { emoji: { name: emoji } } : {})
  };
}

function modal({ customId, title, inputs }) {
  return {
    type: 9,
    data: {
      custom_id: customId,
      title,
      components: inputs.map(inp => ({
        type: 1,
        components: [{
          type: 4,
          custom_id: inp.customId,
          label: inp.label,
          style: inp.multiline ? 2 : 1,
          placeholder: inp.placeholder || '',
          required: inp.required !== false,
          ...(inp.minLength ? { min_length: inp.minLength } : {}),
          ...(inp.maxLength ? { max_length: inp.maxLength } : {})
        }]
      }))
    }
  };
}

async function buildMasterPanel() {
  const matches = await getActiveMatches();

  const upcoming = matches.filter(m => {
    if (m.status !== 'NS') return false;
    const label = getAustralianDayLabel(m.kickoff_time);
    return label === 'Today' || label === 'Tomorrow';
  });

  const aestTime = new Date().toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit'
  });

  const fields = [];

  if (upcoming.length === 0) {
    fields.push({
      name: '⚽  Upcoming Matches',
      value: '```\nNo matches scheduled for Today or Tomorrow (AEST).\nAn admin can run /sync-matches to refresh fixtures.\n```'
    });
  } else {
    const groups = { Today: [], Tomorrow: [] };
    upcoming.forEach(m => {
      const label = getAustralianDayLabel(m.kickoff_time);
      if (groups[label]) groups[label].push(m);
    });

    for (const [day, dayMatches] of Object.entries(groups)) {
      if (!dayMatches.length) continue;
      const lines = [];
      for (const m of dayMatches) {
        const spy = await getSpyMetric(m.fixture_id);
        const total = spy.totalVotes || 0;
        const ts = Math.floor(new Date(m.kickoff_time).getTime() / 1000);

        const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 33;
        const drawShare = total > 0 ? Math.round((spy.draw.votes / total) * 100) : 33;
        const awayShare = 100 - homeShare - drawShare;

        const spyBlock = spy.totalVotes > 0
          ? [
              `\`H ${progressBar(homeShare, 8)} ${String(homeShare).padStart(3)}%  ${fmt(spy.home.tokens)}🪙\``,
              `\`D ${progressBar(drawShare, 8)} ${String(drawShare).padStart(3)}%  ${fmt(spy.draw.tokens)}🪙\``,
              `\`A ${progressBar(awayShare, 8)} ${String(awayShare).padStart(3)}%  ${fmt(spy.away.tokens)}🪙\``
            ].join('\n')
          : '`No wagers yet — be the first!`';

        lines.push(
          `**${m.home_team}  🆚  ${m.away_team}**\n` +
          `<t:${ts}:F>  ·  <t:${ts}:R>\n` +
          `${spyBlock}\n\u200b`
        );
      }
      fields.push({ name: `📅  ${day}'s Matches`, value: lines.join('\n') });
    }
  }

  const panelEmbed = embed({
    color: COLORS.blue,
    title: '🏆  Project Blue-Lock  ·  World Cup 2026',
    description:
      '> Wager fake tokens on real match outcomes.\n' +
      '> The bigger the upset, the bigger the payout.\n' +
      '\u200b',
    fields,
    footer: `🕒 Last updated · ${aestTime} AEST  ·  Use /profile to view your wallet`
  });

  const menuOptions = upcoming.slice(0, 25).map(m => ({
    label: `${m.home_team} vs ${m.away_team}`,
    value: m.fixture_id,
    emoji: '⚽',
    description: new Date(m.kickoff_time).toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: true
    }) + ' AEST'
  }));

  const matchSelect = upcoming.length > 0
    ? selectMenu({ customId: 'select_match', placeholder: '⚽  Select a match to bet on...', options: menuOptions })
    : selectMenu({ customId: 'select_match', placeholder: 'No matches available', options: [{ label: 'No matches', value: 'none' }], disabled: true });

  const row1 = actionRow([matchSelect]);
  const row2 = actionRow([
    button({ customId: 'view_my_history', label: 'My Predictions', emoji: '📊' }),
    button({ customId: 'show_rules', label: 'How to Play', emoji: '📖' })
  ]);

  return { embeds: [panelEmbed], components: [row1, row2] };
}

async function buildMatchDetail(match, user) {
  const spy = await getSpyMetric(match.fixture_id);
  const total = spy.totalVotes || 0;
  const ts = Math.floor(new Date(match.kickoff_time).getTime() / 1000);

  const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 33;
  const drawShare = total > 0 ? Math.round((spy.draw.votes / total) * 100) : 33;
  const awayShare = 100 - homeShare - drawShare;

  const matchEmbed = embed({
    color: COLORS.blue,
    title: `⚽  ${match.home_team}  🆚  ${match.away_team}`,
    description: `**Kickoff:** <t:${ts}:F>  (<t:${ts}:R>)\n\u200b`,
    fields: [
      { name: '💰  Your Wallet', value: `\`${fmt(user.tokens_balance)} tokens\``, inline: true },
      { name: '🧮  Pool Size', value: `\`${fmt(spy.totalTokens)} tokens wagered\``, inline: true },
      { name: '\u200b', value: '\u200b', inline: false },
      {
        name: '📊  Live Spy Metric',
        value:
          `\`H ${progressBar(homeShare, 10)} ${String(homeShare).padStart(3)}%  (${fmt(spy.home.tokens)}🪙)\`\n` +
          `\`D ${progressBar(drawShare, 10)} ${String(drawShare).padStart(3)}%  (${fmt(spy.draw.tokens)}🪙)\`\n` +
          `\`A ${progressBar(awayShare, 10)} ${String(awayShare).padStart(3)}%  (${fmt(spy.away.tokens)}🪙)\``
      }
    ],
    footer: 'Select your prediction below. You can update it any time before kickoff.'
  });

  const predMenu = selectMenu({
    customId: `select_prediction:${match.fixture_id}`,
    placeholder: '🔮  Choose your prediction...',
    options: [
      { label: `${match.home_team} Win`, value: 'home', emoji: '⚽' },
      { label: 'Draw', value: 'draw', emoji: '🤝' },
      { label: `${match.away_team} Win`, value: 'away', emoji: '⚽' }
    ]
  });

  return { embeds: [matchEmbed], components: [actionRow([predMenu])] };
}

function buildBetConfirmEmbed({ match, teamPicked, amountWagered, estEarnings, newBalance, isUpdate }) {
  const pickEmoji = { home: '⚽', draw: '🤝', away: '⚽' }[teamPicked] || '🔮';
  const isFreeVote = amountWagered === 0;
  const ts = Math.floor(new Date(match.kickoff_time).getTime() / 1000);

  const displayPick = teamPicked === 'home' 
    ? match.home_team.toUpperCase() 
    : teamPicked === 'away' 
      ? match.away_team.toUpperCase() 
      : 'DRAW';

  let multiplierStr;
  if (isFreeVote) multiplierStr = 'Free Vote';
  else if (estEarnings.multiplier >= 1.20) multiplierStr = '🔥 1.20x — MIRACLE JACKPOT';
  else if (estEarnings.multiplier >= 1.10) multiplierStr = '⬆️ 1.10x — Underdog Boost';
  else multiplierStr = `1.0x — Standard Split`;

  const isHomeOrAway = teamPicked === 'home' || teamPicked === 'away';
  const refundNote = (!isFreeVote && isHomeOrAway) ? '\n*Note: If this match ends in a Draw, your wager will be fully refunded.*' : '';

  return embed({
    color: isFreeVote ? COLORS.purple : COLORS.green,
    title: isUpdate ? '🔄  Prediction Updated' : '✅  Prediction Locked In',
    description:
      `**${match.home_team}  🆚  ${match.away_team}**\n` +
      `<t:${ts}:R>\n\u200b` +
      refundNote,
    fields: [
      { name: `${pickEmoji}  Pick`, value: `\`\`\`\n${displayPick}\n\`\`\``, inline: true },
      { name: '🪙  Wagered', value: `\`\`\`\n${isFreeVote ? 'Free Vote' : fmt(amountWagered) + ' tokens'}\n\`\`\``, inline: true },
      { name: '📈  Est. Return', value: `\`\`\`\n${isFreeVote ? '+5 tokens' : fmt(estEarnings.estimated) + ' tokens'}\n\`\`\``, inline: true },
      { name: '⚡  Multiplier', value: multiplierStr, inline: true },
      { name: '💰  New Balance', value: `\`${fmt(newBalance)} tokens\``, inline: true }
    ],
    footer: 'You can change your prediction any time before kickoff.'
  });
}

function buildProfileEmbed({ user, activeBets, pastBets }) {
  const wins = pastBets.filter(b => b.team_picked === b.matches?.winner).length;
  const refunds = pastBets.filter(b => b.matches?.winner === 'draw' && b.team_picked !== 'draw').length;
  const losses = pastBets.length - wins - refunds;
  const acc = pastBets.length > 0 ? Math.round((wins / pastBets.length) * 100) : 0;

  const fields = [
    { name: '💰  Wallet', value: `\`\`\`\n${fmt(user.tokens_balance)} tokens\n\`\`\``, inline: true },
    { name: '🏆  Record', value: `\`\`\`\n${wins}W / ${losses}L / ${refunds}R  (${acc}%)\n\`\`\``, inline: true }
  ];

  if (activeBets.length > 0) {
    fields.push({
      name: '\u200b\n🕒  Active Wagers',
      value: activeBets.map(b => {
        const displayPick = b.team_picked === 'home' 
          ? (b.matches?.home_team || 'HOME') 
          : b.team_picked === 'away' 
            ? (b.matches?.away_team || 'AWAY') 
            : 'DRAW';
        return `⚽ **${b.matches?.home_team} vs ${b.matches?.away_team}**\n` +
               `   Picked **${displayPick.toUpperCase()}**  ·  Wager: **${fmt(b.amount_wagered)}🪙**`;
      }).join('\n\n')
    });
  }

  if (pastBets.length > 0) {
    fields.push({
      name: '\u200b\n📜  Recent Results',
      value: pastBets.slice(-5).reverse().map(b => {
        if (b.matches?.winner === 'draw' && b.team_picked !== 'draw') {
          return `↩️  **${b.matches.home_team} vs ${b.matches.away_team}**  ·  Refunded (${fmt(b.amount_wagered)}🪙)`;
        }
        const displayPick = b.team_picked === 'home' 
          ? (b.matches?.home_team