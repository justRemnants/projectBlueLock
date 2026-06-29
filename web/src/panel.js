/**
 * web/src/panel.js
 * 
 * Lightweight layout builder returning raw JSON components for serverless execution.
 */

const { getActiveMatches, getSpyMetric } = require('./database');

const COLORS = {
  blue: 0x1a6bff,
  green: 0x00cc66,
  gold: 0xf1c40f,
  red: 0xff3333,
  purple: 0x9b59b6
};

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

function progressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  const empty = Math.max(0, length - filled);
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function getAustralianDayLabel(kickoffStr) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const nowLabel = formatter.format(new Date());
  const tomorrowLabel = formatter.format(new Date(Date.now() + 86400000));
  const kickoffLabel = formatter.format(new Date(kickoffStr));

  if (kickoffLabel === nowLabel) return 'Today';
  if (kickoffLabel === tomorrowLabel) return 'Tomorrow';
  return null;
}

function modal({ customId, title, inputs }) {
  return {
    type: 9, // MODAL response type
    data: {
      custom_id: customId,
      title: title,
      components: inputs.map(input => ({
        type: 1, // ACTION_ROW
        components: [{
          type: 4, // TEXT_INPUT
          custom_id: input.customId,
          label: input.label,
          style: 1, // SHORT
          placeholder: input.placeholder,
          min_length: input.minLength,
          max_length: input.maxLength,
          required: true
        }]
      }))
    }
  };
}

async function buildMasterPanel() {
  const matches = await getActiveMatches();

  const upcomingMatches = matches.filter(m => {
    if (m.status !== 'NS') return false;
    const label = getAustralianDayLabel(m.kickoff_time);
    return label === 'Today' || label === 'Tomorrow';
  });

  const now = new Date();
  const aestTime = now.toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit', minute: '2-digit'
  });

  const embed = {
    color: COLORS.blue,
    title: '🏆  Project Blue-Lock  •  World Cup 2026',
    description: '> Use fake tokens to predict real match outcomes.\n> The bigger the upset, the bigger the jackpot.\n\n\u200b',
    footer: { text: `🕒 Last updated · ${aestTime} AEST  •  Use /profile to view your wallet` },
    timestamp: new Date().toISOString(),
    fields: []
  };

  if (upcomingMatches.length === 0) {
    embed.fields.push({
      name: '⚽  Upcoming Matches',
      value: '```\nNo matches scheduled for Today or Tomorrow (AEST/AEDT).\nRun /sync-matches to refresh the fixture list.\n```'
    });
  } else {
    const groups = { Today: [], Tomorrow: [] };
    upcomingMatches.forEach(m => {
      const label = getAustralianDayLabel(m.kickoff_time);
      if (groups[label]) groups[label].push(m);
    });

    for (const [day, dayMatches] of Object.entries(groups)) {
      if (dayMatches.length === 0) continue;

      const lines = [];
      for (const m of dayMatches) {
        const spy = await getSpyMetric(m.fixture_id);
        const total = spy.totalVotes || 0;

        const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 33;
        const awayShare = total > 0 ? Math.round((spy.away.votes / total) * 100) : 33;
        const drawShare = total > 0 ? Math.round((spy.draw.votes / total) * 100) : 34;

        const unixTs = Math.floor(new Date(m.kickoff_time).getTime() / 1000);

        const spyBlock = spy.totalVotes > 0
          ? [
              `\`H ${progressBar(homeShare, 8)} ${String(homeShare).padStart(3)}%  ${fmt(spy.home.tokens)}🪙\``,
              `\`D ${progressBar(drawShare, 8)} ${String(drawShare).padStart(3)}%  ${fmt(spy.draw.tokens)}🪙\``,
              `\`A ${progressBar(awayShare, 8)} ${String(awayShare).padStart(3)}%  ${fmt(spy.away.tokens)}🪙\``
            ].join('\n')
          : '`No wagers placed yet — be the first!`';

        lines.push(
          `**${m.home_team}  🆚  ${m.away_team}**\n` +
          `<t:${unixTs}:F>\n` +
          `${spyBlock}\n` +
          `\u200b`
        );
      }

      embed.fields.push({
        name: `📅  ${day}'s Matches`,
        value: lines.join('\n')
      });
    }
  }

  const options = [];
  if (upcomingMatches.length > 0) {
    upcomingMatches.slice(0, 25).forEach(m => {
      options.push({
        label: `${m.home_team} vs ${m.away_team}`,
        value: m.fixture_id,
        description: new Date(m.kickoff_time).toLocaleTimeString('en-AU', {
          timeZone: 'Australia/Sydney',
          hour: '2-digit', minute: '2-digit', hour12: true
        }) + ' AEST',
        emoji: { name: '⚽' }
      });
    });
  } else {
    options.push({
      label: 'No matches available',
      value: 'none'
    });
  }

  const row1 = {
    type: 1, // ACTION_ROW
    components: [{
      type: 3, // STRING_SELECT
      custom_id: 'select_match',
      placeholder: '⚽  Select a match to place or edit your prediction...',
      options: options,
      disabled: upcomingMatches.length === 0
    }]
  };

  const row2 = {
    type: 1, // ACTION_ROW
    components: [
      {
        type: 2, // BUTTON
        style: 2, // SECONDARY
        label: 'My Predictions',
        custom_id: 'view_my_history',
        emoji: { name: '📊' }
      },
      {
        type: 2, // BUTTON
        style: 2, // SECONDARY
        label: 'How to Play',
        custom_id: 'show_rules',
        emoji: { name: '📖' }
      }
    ]
  };

  return { embeds: [embed], components: [row1, row2] };
}

async function buildMatchDetail(match, dbUser) {
  const spy = await getSpyMetric(match.fixture_id);
  const total = spy.totalVotes || 0;

  const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 33;
  const awayShare = total > 0 ? Math.round((spy.away.votes / total) * 100) : 33;
  const drawShare = 100 - homeShare - awayShare;

  const unixTs = Math.floor(new Date(match.kickoff_time).getTime() / 1000);

  const embed = {
    color: COLORS.blue,
    title: `⚽  ${match.home_team}  🆚  ${match.away_team}`,
    description: `**Kickoff:** <t:${unixTs}:F> (<t:${unixTs}:R>)\n\u200b`,
    fields: [
      {
        name: '💰  Your Wallet',
        value: `\`${fmt(dbUser.tokens_balance)} tokens\``,
        inline: true
      },
      {
        name: '🧮  Pool Size',
        value: `\`${fmt(spy.totalTokens)} tokens wagered\``,
        inline: true
      },
      {
        name: '\u200b\n📊  Live Spy Metric',
        value:
          `\`H ${progressBar(homeShare, 10)} ${String(homeShare).padStart(3)}%  (${fmt(spy.home.tokens)}🪙)\`\n` +
          `\`D ${progressBar(drawShare, 10)} ${String(drawShare).padStart(3)}%  (${fmt(spy.draw.tokens)}🪙)\`\n` +
          `\`A ${progressBar(awayShare, 10)} ${String(awayShare).padStart(3)}%  (${fmt(spy.away.tokens)}🪙)\``
      }
    ],
    footer: { text: 'Select your prediction below. You can change it before kickoff.' },
    timestamp: new Date().toISOString()
  };

  const row = {
    type: 1, // ACTION_ROW
    components: [{
      type: 3, // STRING_SELECT
      custom_id: `select_prediction:${match.fixture_id}`,
      placeholder: '🔮  Choose your prediction...',
      options: [
        {
          label: `${match.home_team} Win`,
          value: 'home',
          emoji: { name: '⚽' }
        },
        {
          label: 'Draw',
          value: 'draw',
          emoji: { name: '🤝' }
        },
        {
          label: `${match.away_team} Win`,
          value: 'away',
          emoji: { name: '⚽' }
        }
      ]
    }]
  };

  return { embeds: [embed], components: [row] };
}

function buildBetConfirmEmbed({ match, teamPicked, amountWagered, estEarnings, newBalance, isUpdate }) {
  const isFreeVote = amountWagered === 0;
  const displayPick = teamPicked === 'home'
    ? match.home_team.toUpperCase()
    : teamPicked === 'away'
      ? match.away_team.toUpperCase()
      : 'DRAW';

  const pickEmoji = { home: '⚽', draw: '🤝', away: '⚽' }[teamPicked] || '🔮';

  const multiplierStr = isFreeVote
    ? 'Free Vote'
    : estEarnings.multiplier > 1.0
      ? `🔥 ${estEarnings.multiplier}x UNDERDOG BOOST`
      : `${estEarnings.multiplier}x`;

  const isHomeOrAway = teamPicked === 'home' || teamPicked === 'away';
  const refundNote = (!isFreeVote && isHomeOrAway) ? '\n*Note: If this match ends in a Draw, your wager will be fully refunded.*' : '';

  return {
    color: isFreeVote ? COLORS.purple : COLORS.green,
    title: isUpdate ? '🔄  Prediction Updated' : '✅  Prediction Locked In',
    description:
      `**${match.home_team}  🆚  ${match.away_team}**\n` +
      `<t:${Math.floor(new Date(match.kickoff_time).getTime() / 1000)}:R>\n\u200b` +
      refundNote,
    fields: [
      {
        name: `${pickEmoji}  Your Pick`,
        value: `\`\`\`\n${displayPick}\n\`\`\n`,
        inline: true
      },
      {
        name: '🪙  Wagered',
        value: `\`\`\`\n${isFreeVote ? 'Free Vote' : fmt(amountWagered) + ' tokens'}\n\`\`\n`,
        inline: true
      },
      {
        name: '📈  Est. Return',
        value: `\`\`\`\n${isFreeVote ? '+5 tokens (if correct)' : fmt(estEarnings.estimated) + ' tokens'}\n\`\`\n`,
        inline: true
      },
      {
        name: '⚡  Multiplier',
        value: multiplierStr,
        inline: true
      },
      {
        name: '💰  New Balance',
        value: `\`${fmt(newBalance)} tokens\``,
        inline: true
      }
    ],
    footer: { text: 'You can change your prediction any time before kickoff.' },
    timestamp: new Date().toISOString()
  };
}

function buildProfileEmbed({ user, activeBets, pastBets }) {
  const wins = pastBets.filter(b => b.team_picked === b.matches?.winner).length;
  const refunds = pastBets.filter(b => b.matches?.winner === 'draw' && b.team_picked !== 'draw').length;
  const losses = pastBets.length - wins - refunds;
  const accuracy = pastBets.length > 0 ? Math.round((wins / pastBets.length) * 100) : 0;

  const embed = {
    color: COLORS.blue,
    title: `${user.display_name || user.username}`,
    description: `> <@${user.discord_id}>\n\u200b`,
    thumbnail: user.avatar_url ? { url: user.avatar_url } : null,
    fields: [
      {
        name: '💰  Wallet',
        value: `\`\`\`\n${fmt(user.tokens_balance)} tokens\n\`\`\n`,
        inline: true
      },
      {
        name: '🏆  Win Rate',
        value: `\`\`\`\n${wins}W / ${losses}L / ${refunds}R (${accuracy}%)\n\`\`\n`,
        inline: true
      }
    ],
    footer: { text: 'Use the dropdown in the events panel to place a bet' },
    timestamp: new Date().toISOString()
  };

  if (activeBets.length > 0) {
    const list = activeBets.map(b => {
      const displayPick = b.team_picked === 'home'
        ? (b.matches?.home_team || 'HOME')
        : b.team_picked === 'away'
          ? (b.matches?.away_team || 'AWAY')
          : 'DRAW';
      return `⚽ **${b.matches?.home_team} vs ${b.matches?.away_team}**\n` +
             `   Picked: **${displayPick.toUpperCase()}**  •  Wager: **${fmt(b.amount_wagered)}🪙**`;
    }).join('\n\n');
    embed.fields.push({ name: '\u200b\n🕒  Active Wagers', value: list });
  }

  if (pastBets.length > 0) {
    const lines = pastBets.slice(-5).reverse().map(b => {
      if (b.matches?.winner === 'draw' && b.team_picked !== 'draw') {
        return `↩️  **${b.matches?.home_team} vs ${b.matches?.away_team}**  •  Refunded (${fmt(b.amount_wagered)}🪙)`;
      }
      const displayPick = b.team_picked === 'home'
        ? (b.matches?.home_team || 'HOME')
        : b.team_picked === 'away'
          ? (b.matches?.away_team || 'AWAY')
          : 'DRAW';
      const won = b.team_picked === b.matches?.winner;
      return `${won ? '✅' : '❌'}  **${b.matches?.home_team} vs ${b.matches?.away_team}**  •  ${displayPick.toUpperCase()}  (${fmt(b.amount_wagered)}🪙)`;
    }).join('\n');
    embed.fields.push({ name: '\u200b\n📜  Recent Results', value: lines });
  }

  return embed;
}

module.exports = {
  COLORS,
  fmt,
  modal,
  buildMasterPanel,
  buildMatchDetail,
  buildBetConfirmEmbed,
  buildProfileEmbed
};