/**
 * web/src/panel.js
 * 
 * Lightweight layout builder returning raw JSON components for serverless execution.
 * Configured with FIFA Timezone (EST/EDT - America/New_York), strike-through text for 
 * occurred matches, team vs separators set to ⚔️, and dynamic 30% wealth bet limitations.
 * Features readable team names and country flags in the Live Spy Metrics and Match lists.
 */

const { getActiveMatches, getSpyMetric, getUserHistory } = require('./database');

const COLORS = {
  blue: 0x1a6bff,
  green: 0x00cc66,
  gold: 0xf1c40f,
  red: 0xff3333,
  purple: 0x9b59b6
};

// Map country names to flag emojis for clean layout presentation
const COUNTRY_FLAGS = {
  "Argentina": "🇦🇷", "Australia": "🇦🇺", "Belgium": "🇧🇪", "Brazil": "🇧🇷",
  "Canada": "🇨🇦", "Cameroon": "🇨🇲", "Costa Rica": "🇨🇷", "Croatia": "🇭🇷",
  "Denmark": "🇩🇰", "Ecuador": "🇪🇨", "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "France": "🇫🇷",
  "Germany": "🇩🇪", "Ghana": "🇬🇭", "Iran": "🇮🇷", "Japan": "🇯🇵",
  "Mexico": "🇲🇽", "Morocco": "🇲🇦", "Netherlands": "🇳🇱", "Poland": "🇵🇱",
  "Portugal": "🇵🇹", "Qatar": "🇶🇦", "Saudi Arabia": "🇸🇦", "Senegal": "🇸🇳",
  "Serbia": "🇷🇸", "South Korea": "🇰🇷", "Spain": "🇪🇸", "Switzerland": "🇨🇭",
  "Tunisia": "🇹🇳", "USA": "🇺🇸", "United States": "🇺🇸", "Uruguay": "🇺🇾", "Wales": "🏴󠁧󠁢󠁷󠁬󠁳󠁿"
};

function getFlag(teamName) {
  return COUNTRY_FLAGS[teamName] || "⚽";
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

function progressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  const empty = Math.max(0, length - filled);
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function getFIFADayLabel(kickoffStr) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const nowLabel = formatter.format(new Date());
  const tomorrowLabel = formatter.format(new Date(Date.now() + 86400000));
  const kickoffLabel = formatter.format(new Date(kickoffStr));

  if (kickoffLabel === nowLabel) return 'Today';
  if (kickoffLabel === tomorrowLabel) return 'Tomorrow';
  return null;
}

/**
 * Calculates the Day of the World Cup (World Cup 2026 starts on June 11, 2026)
 */
function getWorldCupDay(kickoffStr) {
  const msInDay = 86400000;
  
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });

  const startStr = "2026-06-11"; // Opening day of World Cup 2026
  const kickoffStrNY = formatter.format(new Date(kickoffStr));

  const startParsed = new Date(startStr);
  const kickoffParsed = new Date(kickoffStrNY);

  const diffTime = Math.abs(kickoffParsed - startParsed);
  const diffDays = Math.ceil(diffTime / msInDay) + 1; // June 11 is Day 1

  return diffDays;
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

  // Find matches scheduled for Today or Tomorrow in the FIFA timezone (America/New_York)
  const upcomingMatches = matches.filter(m => {
    const label = getFIFADayLabel(m.kickoff_time);
    return label === 'Today' || label === 'Tomorrow';
  });

  const now = new Date();
  const fifaTime = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  const embed = {
    color: COLORS.blue,
    title: '🏆  Project Blue-Lock  •  World Cup 2026',
    description: 'Bet on matches to become the richest in the server\nBut don\'t get too greedy...\n\n\u200b',
    footer: { text: `🕒 Last updated · ${fifaTime}  •  Use /profile to view your wallet` },
    timestamp: new Date().toISOString(),
    fields: []
  };

  if (upcomingMatches.length === 0) {
    embed.fields.push({
      name: '⚽  Upcoming Matches',
      value: '```\nNo matches scheduled for Today or Tomorrow in USA East Time.\nRun /sync-matches to refresh the list.\n```'
    });
  } else {
    const groups = { Today: [], Tomorrow: [] };
    upcomingMatches.forEach(m => {
      const label = getFIFADayLabel(m.kickoff_time);
      if (groups[label]) groups[label].push(m);
    });

    for (const [day, dayMatches] of Object.entries(groups)) {
      if (dayMatches.length === 0) continue;

      const sampleMatch = dayMatches[0];
      const worldCupDayNumber = getWorldCupDay(sampleMatch.kickoff_time);

      const lines = [];
      for (const m of dayMatches) {
        const spy = await getSpyMetric(m.fixture_id);
        const total = spy.totalVotes || 0;

        const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 33;
        const awayShare = total > 0 ? Math.round((spy.away.votes / total) * 100) : 33;
        const drawShare = total > 0 ? Math.round((spy.draw.votes / total) * 100) : 34;

        const unixTs = Math.floor(new Date(m.kickoff_time).getTime() / 1000);

        // Check if the kickoff time has passed or match is finished
        const kickedOff = new Date() >= new Date(m.kickoff_time);
        const isFinished = m.status === 'FT';
        const isLive = m.status === 'LIVE';

        let statusSuffix = '';
        if (isFinished) statusSuffix = ' (Finished 🏁)';
        else if (isLive) statusSuffix = ' (LIVE 🔴)';
        else if (kickedOff) statusSuffix = ' (Kicked Off 🕒)';

        const homeFlag = getFlag(m.home_team);
        const awayFlag = getFlag(m.away_team);

        // Match headers formatted with flags directly next to each nation
        const matchHeader = `${homeFlag} **${m.home_team}**  ⚔️  **${m.away_team}** ${awayFlag}${statusSuffix}`;
        const matchDisplay = (kickedOff || isFinished) ? `~~${matchHeader}~~` : matchHeader;

        const spyBlock = spy.totalVotes > 0
          ? [
              `${homeFlag} **${m.home_team}** · \`${progressBar(homeShare, 8)} ${String(homeShare).padStart(3)}%  ${fmt(spy.home.tokens)}🪙\``,
              `🤝 **Draw** · \`${progressBar(drawShare, 8)} ${String(drawShare).padStart(3)}%  ${fmt(spy.draw.tokens)}🪙\``,
              `${awayFlag} **${m.away_team}** · \`${progressBar(awayShare, 8)} ${String(awayShare).padStart(3)}%  ${fmt(spy.away.tokens)}🪙\``
            ].join('\n')
          : '`No wagers placed yet`';

        lines.push(
          `${matchDisplay}\n` +
          `Kickoff: <t:${unixTs}:F> (<t:${unixTs}:R>)\n` +
          `${spyBlock}\n` +
          `\u200b`
        );
      }

      embed.fields.push({
        name: `📅  Day ${worldCupDayNumber} Matches (${day})`,
        value: lines.join('\n')
      });
    }
  }

  // Filter out matches that have already kicked off/occurred so users can't select them
  const openMatches = upcomingMatches.filter(m => {
    const kickedOff = new Date() >= new Date(m.kickoff_time);
    return !kickedOff && m.status === 'NS';
  });

  const options = [];
  if (openMatches.length > 0) {
    openMatches.slice(0, 25).forEach(m => {
      const displayTime = new Date(m.kickoff_time).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', hour12: true
      }) + ' EST';

      options.push({
        label: `${m.home_team} vs ${m.away_team}`,
        value: m.fixture_id,
        description: `Starts at ${displayTime}`,
        emoji: { name: '⚽' }
      });
    });
  } else {
    options.push({
      label: 'No open matches available to bet on',
      value: 'none'
    });
  }

  const row1 = {
    type: 1, // ACTION_ROW
    components: [{
      type: 3, // STRING_SELECT
      custom_id: 'select_match',
      placeholder: '🔮 Pick an upcoming match to bet on...',
      options: options,
      disabled: openMatches.length === 0
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

  // Dynamic maximum bet calculations (30% of Total Wealth or 300, whichever is lower)
  const history = await getUserHistory(dbUser.discord_id);
  const activeBets = history.filter(b => b.matches?.status === 'NS');
  const totalActiveWagered = activeBets.reduce((sum, b) => sum + b.amount_wagered, 0);
  const totalWealth = dbUser.tokens_balance + totalActiveWagered;
  const maxBet = Math.min(Math.floor(totalWealth * 0.30), 300);

  const homeFlag = getFlag(match.home_team);
  const awayFlag = getFlag(match.away_team);

  const embed = {
    color: COLORS.blue,
    title: `⚽  ${match.home_team}  ⚔️  ${match.away_team}`,
    description: `**Kickoff:** <t:${unixTs}:F> (<t:${unixTs}:R>)\n\u200b`,
    fields: [
      {
        name: '💰 Wallet',
        value: `\`${fmt(dbUser.tokens_balance)} tokens\``,
        inline: true
      },
      {
        name: '🛡️ Max Bet Allowed',
        value: `\`${fmt(maxBet)} tokens\`\n*(30% of total wealth)*`,
        inline: true
      },
      {
        name: '🧮 Wagered Pool',
        value: `\`${fmt(spy.totalTokens)} tokens total\``,
        inline: true
      },
      {
        name: '\u200b\n📊 Live Bet Split (Spy Metric)',
        value:
          `${homeFlag} **${match.home_team}** · \`${progressBar(homeShare, 10)} ${String(homeShare).padStart(3)}%  (${fmt(spy.home.tokens)}🪙)\`\n` +
          `🤝 **Draw** · \`${progressBar(drawShare, 10)} ${String(drawShare).padStart(3)}%  (${fmt(spy.draw.tokens)}🪙)\`\n` +
          `${awayFlag} **${match.away_team}** · \`${progressBar(awayShare, 10)} ${String(awayShare).padStart(3)}%  (${fmt(spy.away.tokens)}🪙)\``
      }
    ],
    footer: { text: 'Choose your prediction. You can change your selection anytime before kickoff.' },
    timestamp: new Date().toISOString()
  };

  const row = {
    type: 1, // ACTION_ROW
    components: [{
      type: 3,
      custom_id: `select_prediction:${match.fixture_id}`,
      placeholder: '🔮 Choose your predicted winner...',
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
      ? `🔥 ${estEarnings.multiplier}x Underdog Boost`
      : `${estEarnings.multiplier}x`;

  const isHomeOrAway = teamPicked === 'home' || teamPicked === 'away';
  const refundNote = (!isFreeVote && isHomeOrAway) ? '\n*Note: If the match ends in a Draw, your wager will be fully refunded.*' : '';

  return {
    color: isFreeVote ? COLORS.purple : COLORS.green,
    title: isUpdate ? '🔄 Prediction Updated' : '✅ Prediction Locked In',
    description:
      `**${match.home_team}  ⚔️  ${match.away_team}**\n` +
      `Starts <t:${Math.floor(new Date(match.kickoff_time).getTime() / 1000)}:R>\n\u200b` +
      refundNote,
    fields: [
      {
        name: `${pickEmoji} Your Pick`,
        value: `\`\`\`\n${displayPick}\n\`\`\prime,
        inline: true
      },
      {
        name: '🪙 Wager',
        value: `\`\`\`\n${isFreeVote ? 'Free Vote' : fmt(amountWagered) + ' tokens'}\n\`\`\prime,
        inline: true
      },
      {
        name: '📈 Est. Payout',
        value: `\`\`\`\n${isFreeVote ? '+5 tokens (if correct)' : fmt(estEarnings.estimated) + ' tokens'}\n\`\`\prime,
        inline: true
      },
      {
        name: '⚡ Multiplier',
        value: multiplierStr,
        inline: true
      },
      {
        name: '💰 New Balance',
        value: `\`${fmt(newBalance)} tokens\``,
        inline: true
      }
    ],
    footer: { text: 'You can update your pick anytime before kickoff.' },
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
        name: '💰 Wallet Balance',
        value: `\`\`\`\n${fmt(user.tokens_balance)} tokens\n\`\`\prime,
        inline: true
      },
      {
        name: '🏆 Record',
        value: `\`\`\`\n${wins}W / ${losses}L / ${refunds}R (${accuracy}%)\n\`\`\prime,
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
      return `⚽ **${b.matches?.home_team} ⚔️ ${b.matches?.away_team}**\n` +
             `   Picked: **${displayPick.toUpperCase()}**  •  Wager: **${fmt(b.amount_wagered)}🪙**`;
    }).join('\n\n');
    embed.fields.push({ name: '\u200b\n🕒 Active Wagers', value: list });
  }

  if (pastBets.length > 0) {
    const lines = pastBets.slice(-5).reverse().map(b => {
      if (b.matches?.winner === 'draw' && b.team_picked !== 'draw') {
        return `↩️  **${b.matches?.home_team} ⚔️ ${b.matches?.away_team}**  •  Refunded (${fmt(b.amount_wagered)}🪙)`;
      }
      const displayPick = b.team_picked === 'home'
        ? (b.matches?.home_team || 'HOME')
        : b.team_picked === 'away'
          ? (b.matches?.away_team || 'AWAY')
          : 'DRAW';
      const won = b.team_picked === b.matches?.winner;
      return `${won ? '✅' : '❌'}  **${b.matches?.home_team} ⚔️ ${b.matches?.away_team}**  •  ${displayPick.toUpperCase()}  (${fmt(b.amount_wagered)}🪙)`;
    }).join('\n');
    embed.fields.push({ name: '\u200b\n📜 Recent Results', value: lines });
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