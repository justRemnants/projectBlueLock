/**
 * web/src/panel.js
 * 
 * Lightweight layout builder returning raw JSON components for serverless execution.
 * Configured with FIFA Timezone (EST/EDT - America/New_York), strike-through text for 
 * occurred matches, team vs separators set to ⚔️, and dynamic 30% wealth bet limitations.
 * Features readable team names and country flags in the Live Spy Metrics and Match lists.
 * Utilizes a monospaced format helper to ensure aligned progress bars and stats.
 * Refactored for Knockout Stages: "Draw" has been removed from all user-facing selections and metrics.
 */

const { getActiveMatches, getSpyMetric, getUserHistory, supabase, getConfigValue, getUserStreak } = require('./database');

const COLORS = {
  blue: 0x1a6bff,
  green: 0x00cc66,
  gold: 0xf1c40f,
  red: 0xff3333,
  purple: 0x9b59b6
};

const COUNTRY_FLAGS = {
  "Argentina": "🇦🇷", "Australia": "🇦🇺", "Belgium": "🇧🇪", "Brazil": "🇧🇷",
  "Canada": "🇨🇦", "Cameroon": "🇨🇲", "Costa Rica": "🇨🇷", "Croatia": "🇭🇷",
  "Denmark": "🇩🇰", "Ecuador": "🇪🇨", "England": "🏴󠁧󠁢🇪󠁮󠁧󠁿", "France": "🇫🇷",
  "Germany": "🇩🇪", "Ghana": "🇬🇭", "Iran": "🇮🇷", "Japan": "🇯🇵",
  "Mexico": "🇲🇽", "Morocco": "🇲🇦", "Netherlands": "🇳🇱", "Poland": "🇵🇱",
  "Portugal": "🇵🇹", "Qatar": "🇶🇦", "Saudi Arabia": "🇸🇦", "Senegal": "🇸🇳",
  "Serbia": "🇷🇸", "South Korea": "🇰🇷", "Spain": "🇪🇸", "Switzerland": "🇨🇭",
  "Tunisia": "🇹🇳", "USA": "🇺🇸", "United States": "🇺🇸", "Uruguay": "🇺🇾", "Wales": "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "Italy": "🇮🇹", "Sweden": "🇸🇪", "Colombia": "🇨🇴", "Peru": "🇵🇪", "Chile": "🇨🇱", 
  "Nigeria": "🇳🇬", "Algeria": "🇩🇿", "Egypt": "🇪🇬", "New Zealand": "🇳🇿",
  "Norway": "🇳🇴", "Congo DR": "🇨🇩", "DR Congo": "🇨🇩", "Ivory Coast": "🇨🇮", 
  "Cote d'Ivoire": "🇨🇮", "Bosnia-Herzegovina": "🇧🇦", "Bosnia and Herzegovina": "🇧🇦",
  "Republic of the Congo": "🇨🇬", "Congo": "🇨🇬",
  "Austria": "🇦🇹", "Ukraine": "🇺🇦", "Turkey": "🇹🇷", "Czechia": "🇨🇿", 
  "Czech Republic": "🇨🇿", "Slovakia": "🇸🇰", "Slovenia": "🇸🇮", "Georgia": "🇬🇪", 
  "Albania": "🇦🇱", "Hungary": "🇭🇺", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "Romania": "🇷🇴"
};

function getFlag(teamName) {
  return COUNTRY_FLAGS[teamName] || "⚽";
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

function progressBar(percent, length = 6) {
  const filled = Math.round((percent / 100) * length);
  const empty = Math.max(0, length - filled);
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function formatSpyLine(flag, label, percent, tokens, barLength = 6) {
  const shortName = shortenTeamName(label);
  const bar = progressBar(percent, barLength);
  const nameStr = shortName.padEnd(11, ' '); // Align names to 11 character width
  const percentStr = String(percent).padStart(3) + '%';
  const tokenStr = fmt(tokens) + '🪙';
  
  return `${flag} \`${nameStr} ${bar} ${percentStr}  ${tokenStr}\``;
}

function shortenTeamName(name) {
  if (!name) return "";
  if (name === "Bosnia-Herzegovina" || name === "Bosnia and Herzegovina") return "Bosnia-Herz.";
  if (name === "United States") return "USA";
  if (name === "Saudi Arabia") return "Saudi Arab.";
  if (name === "Congo DR" || name === "DR Congo") return "DR Congo";
  if (name === "Ivory Coast" || name === "Cote d'Ivoire") return "Ivory Coast";
  if (name === "Republic of the Congo") return "Congo Rep.";
  return name.length > 11 ? name.substring(0, 10) + "." : name;
}

function getFIFADayLabel(kickoffStr) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const now = new Date();
  const nowLabel = formatter.format(now);
  const tomorrowLabel = formatter.format(new Date(now.getTime() + 86400000));
  const nextDayLabel = formatter.format(new Date(now.getTime() + 2 * 86400000));
  const kickoffLabel = formatter.format(new Date(kickoffStr));

  if (kickoffLabel === nowLabel) return 'Today';
  if (kickoffLabel === tomorrowLabel) return 'Tomorrow';
  if (kickoffLabel === nextDayLabel) return 'In 2 Days';
  return null;
}

function getWorldCupDay(kickoffStr) {
  const msInDay = 86400000;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const startStr = "2026-06-11";
  const kickoffStrNY = formatter.format(new Date(kickoffStr));
  const startParsed = new Date(startStr);
  const kickoffParsed = new Date(kickoffStrNY);
  return Math.ceil(Math.abs(kickoffParsed - startParsed) / msInDay) + 1;
}

/**
 * REST integration modal payload builder
 */
function modal({ customId, title, inputs }) {
  return {
    type: 9,
    data: {
      custom_id: customId,
      title: title,
      components: inputs.map(input => ({
        type: 1,
        components: [{
          type: 4,
          custom_id: input.customId,
          label: input.label,
          style: 1,
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
    const label = getFIFADayLabel(m.kickoff_time);
    return label === 'Today' || label === 'Tomorrow' || label === 'In 2 Days';
  });

  const now = new Date();
  const fifaTime = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  const embed = {
    color: COLORS.blue,
    title: '🏆  Project Blue-Lock  •  World Cup 2026',
    description: "> Bet on matches to become the richest in the server\n> But don't get too greedy...\n\n\u200b",
    footer: { text: `🕒 Last updated · ${fifaTime}  •  Use /profile to view your wallet` },
    timestamp: new Date().toISOString(),
    fields: []
  };

  if (upcomingMatches.length === 0) {
    embed.fields.push({
      name: '⚽  Upcoming Matches',
      value: "```\nNo matches scheduled for the next 72 hours in USA East Time.\nRun /sync to refresh the list.\n```"
    });
  } else {
    const groups = { Today: [], Tomorrow: [], 'In 2 Days': [] };
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

        const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 50;
        const awayShare = total > 0 ? (100 - homeShare) : 50;

        const unixTs = Math.floor(new Date(m.kickoff_time).getTime() / 1000);

        const kickedOff = new Date() >= new Date(m.kickoff_time);
        const isFinished = m.status === 'FT';
        const isLive = m.status === 'LIVE';

        let statusSuffix = '';
        if (isFinished) statusSuffix = ' (Finished 🏁)';
        else if (isLive) statusSuffix = ' (LIVE 🔴)';
        else if (kickedOff) statusSuffix = ' (Kicked Off 🕒)';

        const homeFlag = getFlag(m.home_team);
        const awayFlag = getFlag(m.away_team);

        const matchHeader = `${homeFlag} **${m.home_team}**  ⚔️  **${m.away_team}** ${awayFlag}${statusSuffix}`;
        const matchDisplay = (kickedOff || isFinished) ? `~~${matchHeader}~~` : matchHeader;

        const spyBlock = spy.totalVotes > 0
          ? [
              formatSpyLine(homeFlag, m.home_team, homeShare, spy.home.tokens, 6),
              formatSpyLine(awayFlag, m.away_team, awayShare, spy.away.tokens, 6)
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
    type: 1,
    components: [{
      type: 3,
      custom_id: 'select_match',
      placeholder: '🔮 Pick an upcoming match to bet on...',
      options: options,
      disabled: openMatches.length === 0
    }]
  };

  const row2 = {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: 'My Predictions',
        custom_id: 'view_my_history',
        emoji: { name: '📊' }
      },
      {
        type: 2,
        style: 2,
        label: 'Leaderboard',
        custom_id: 'view_leaderboard',
        emoji: { name: '🏆' }
      },
      {
        type: 2,
        style: 2,
        label: 'Rules Book',
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

  const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 50;
  const awayShare = total > 0 ? (100 - homeShare) : 50;

  const unixTs = Math.floor(new Date(match.kickoff_time).getTime() / 1000);

  const history = await getUserHistory(dbUser.discord_id);
  const activeBets = history.filter(b => !b.settled);
  const totalActiveWagered = activeBets.reduce((sum, b) => sum + b.amount_wagered, 0);
  const totalWealth = dbUser.tokens_balance + totalActiveWagered;
  const maxBet = Math.min(Math.floor(totalWealth * 0.30), 300);

  const homeFlag = getFlag(match.home_team);
  const awayFlag = getFlag(match.away_team);

  const userClass = await getConfigValue(`class:${dbUser.discord_id}`);
  const classWarning = !userClass 
    ? '\n\n⚠️ **Class Choice Pending:** You have not locked in your Class yet. Open your `/profile` or click "My Predictions" and select a Class using the dropdown to activate passive boosts!'
    : '';

  const rawTicketUsedCount = await supabase
    .from('system_config')
    .select('key')
    .like('key', `ticket_used:${dbUser.discord_id}:%`);
  const ticketUsedCount = rawTicketUsedCount.data?.length || 0;
  const maxTicketsAllowed = userClass === 'renegade' ? 2 : 1;
  const ticketsLeft = Math.max(0, maxTicketsAllowed - ticketUsedCount);

  const embed = {
    color: COLORS.blue,
    title: `${homeFlag}  ${match.home_team}  ⚔️  ${match.away_team}  ${awayFlag}`,
    description: `**Kickoff:** <t:${unixTs}:F> (<t:${unixTs}:R>)${classWarning}\n\u200b`,
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
        name: '🎟️ Golden Tickets',
        value: `\`${ticketsLeft} remaining\`\n*(${(userClass || 'None').toUpperCase()} Class)*`,
        inline: true
      },
      {
        name: '🧮 Wagered Pool',
        value: `\`${fmt(spy.totalTokens)} tokens total\``,
        inline: true
      },
      {
        name: '\u200b\n📊 Live Bet Split (Spy Metric)',
        value: [
          formatSpyLine(homeFlag, match.home_team, homeShare, spy.home.tokens, 8),
          formatSpyLine(awayFlag, match.away_team, awayShare, spy.away.tokens, 8)
        ].join('\n')
      }
    ],
    footer: { text: 'Choose your prediction. You can change your selection anytime before kickoff.' },
    timestamp: new Date().toISOString()
  };

  const row1 = {
    type: 1,
    components: [{
      type: 3,
      custom_id: `select_prediction:${match.fixture_id}`,
      placeholder: '🔮 Choose your predicted winner...',
      options: [
        {
          label: `${match.home_team} Win`,
          value: 'home',
          emoji: { name: homeFlag }
        },
        {
          label: `${match.away_team} Win`,
          value: 'away',
          emoji: { name: awayFlag }
        }
      ]
    }]
  };

  const row2 = {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: 'Apply Ticket',
        custom_id: `apply_ticket:${match.fixture_id}`,
        emoji: { name: '🎟️' }
      },
      {
        type: 2,
        style: 2,
        label: 'Investigate',
        custom_id: `audit_match_prompt:${match.fixture_id}`,
        emoji: { name: '🔍' }
      },
      {
        type: 2,
        style: 2,
        label: ' ', 
        custom_id: `cheat_match_prompt:${match.fixture_id}`
      }
    ]
  };

  return { embeds: [embed], components: [row1, row2] };
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
        value: "```\n" + displayPick + "\n```",
        inline: true
      },
      {
        name: '🪙 Wager',
        value: "```\n" + (isFreeVote ? 'Free Vote' : fmt(amountWagered) + ' tokens') + "\n```",
        inline: true
      },
      {
        name: '📈 Est. Payout',
        value: "```\n" + (isFreeVote ? '+5 tokens (if correct)' : fmt(estEarnings.estimated) + ' tokens') + "\n```",
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

async function buildProfileEmbed({ user, activeBets, pastBets }) {
  const wins = pastBets.filter(b => b.team_picked === b.matches?.winner).length;
  const refunds = pastBets.filter(b => b.matches?.winner === 'draw' && b.team_picked !== 'draw').length;
  const losses = pastBets.length - wins - refunds;
  const accuracy = pastBets.length > 0 ? Math.round((wins / pastBets.length) * 100) : 0;

  const userClass = await getConfigValue(`class:${user.discord_id}`);
  const currentStreak = await getUserStreak(user.discord_id, [...activeBets, ...pastBets]);
  const shieldState = await getConfigValue(`oracle_shield:${user.discord_id}`) || 'off';
  const rawTicketUsedCount = await supabase
    .from('system_config')
    .select('key')
    .like('key', `ticket_used:${user.discord_id}:%`);
  const ticketUsedCount = rawTicketUsedCount.data?.length || 0;
  const maxTicketsAllowed = userClass === 'renegade' ? 2 : 1;
  const ticketsLeft = Math.max(0, maxTicketsAllowed - ticketUsedCount);

  let classPassiveInfo = '⚠️  **Class Choice Pending:** You have not locked in your Class yet. Select your Class using the dropdown below to unlock passive boosts, Golden Tickets, and cheat exploits!';
  if (userClass === 'oracle') {
    classPassiveInfo = `*Streak Shield:* **${shieldState.toUpperCase()}**\n*(Protect your win streak at the cost of -10 flat tokens per win)*`;
  } else if (userClass === 'renegade') {
    classPassiveInfo = `*Double Underdog Tickets:* **${ticketsLeft}/${maxTicketsAllowed} left**\n*(1.5x payout on underdog wins < 40%)*`;
  } else if (userClass === 'tank') {
    classPassiveInfo = `*Loss Insurance:* **35% automatic refund** on lost bets over 200 tokens\n*(50% reduction in cheating fine amounts)*`;
  } else if (userClass === 'syndicate') {
    const partnerId = await getConfigValue(`partner:${user.discord_id}`) || 'Unlinked';
    classPassiveInfo = `*Co-op Partner:* ${partnerId === 'Unlinked' ? 'Unlinked' : `<@${partnerId}>`}\n*(If either partner wins, both win the entire event!)*`;
  } else if (userClass === 'auditor') {
    classPassiveInfo = `*Sheriff Passive:* Probes are 50% cheaper, correct audits pay 1.5x bounty, completely immune to sabotage.`;
  } else if (userClass === 'investigator') {
    classPassiveInfo = `*Investigator Passive:* Investigating others is 50% cheaper, plus receives immunity to sabotages.`;
  }

  const embed = {
    color: COLORS.blue,
    title: `${user.display_name || user.username}`,
    description: `> <@${user.discord_id}>\n\u200b`,
    thumbnail: user.avatar_url ? { url: user.avatar_url } : null,
    fields: [
      {
        name: '💰 Wallet Balance',
        value: `\`\`\`\n${fmt(user.tokens_balance)} tokens\n\`\`\n`,
        inline: true
      },
      {
        name: '🏆 Record',
        value: `\`\`\`\n${wins}W / ${losses}L / ${refunds}R (${accuracy}%)\n\`\`\n`,
        inline: true
      },
      {
        name: `🔥 Streak: ${currentStreak}`,
        value: `\`\`\`\nMultiplier: ${currentStreak >= 3 ? '1.5x' : currentStreak >= 2 ? '1.2x' : '1.0x'}\n\`\`\n`,
        inline: true
      },
      {
        name: '🛡️ Class Passive Reminders',
        value: classPassiveInfo
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
      const homeFlag = getFlag(b.matches?.home_team);
      const awayFlag = getFlag(b.matches?.away_team);

      const wagerValue = b.amount_wagered === 0 ? 'Free Vote' : `${fmt(b.amount_wagered)}🪙`;

      return `${homeFlag} **${b.matches?.home_team}** ⚔️ **${b.matches?.away_team}** ${awayFlag}\n` +
             `   Prediction: **${displayPick.toUpperCase()}**  •  Wager: **${wagerValue}**`;
    }).join('\n\n');
    embed.fields.push({ name: '\u200b\n🕒 Active Wagers', value: list });
  }

  if (pastBets.length > 0) {
    const lines = pastBets.slice(-5).reverse().map(b => {
      const homeFlag = getFlag(b.matches?.home_team);
      const awayFlag = getFlag(b.matches?.away_team);

      const displayWager = b.amount_wagered === 0 ? 'Free Vote' : `${fmt(b.amount_wagered)}🪙`;

      if (b.matches?.winner === 'draw' && b.team_picked !== 'draw') {
        return `↩️  **${b.matches?.home_team} ⚔️ ${b.matches?.away_team}**  •  Refunded (${displayWager})`;
      }
      
      const displayPick = b.team_picked === 'home'
        ? (b.matches?.home_team || 'HOME')
        : b.team_picked === 'away'
          ? (b.matches?.away_team || 'AWAY')
          : 'DRAW';
      const won = b.team_picked === b.matches?.winner;
      
      const resultIcon = won ? '✅' : '❌';
      const resultText = won ? 'Correct prediction' : 'Incorrect prediction';
      
      const winnerLabel = b.matches?.winner === 'draw' 
        ? 'Draw' 
        : b.matches?.winner === 'home' 
          ? b.matches?.home_team 
          : b.matches?.away_team;

      return `${resultIcon}  ${homeFlag} **${b.matches?.home_team} vs ${b.matches?.away_team}** ${awayFlag}\n` +
             `   Pick: **${displayPick.toUpperCase()}** • Wager: **${displayWager}** • Result: **Winner: ${(winnerLabel || 'Undecided').toUpperCase()}** (${resultText})`;
    }).join('\n\n');
    embed.fields.push({ name: '\u200b\n📜 Recent Results (Last 5)', value: lines });
  }

  const rowSelect = {
    type: 1,
    components: [{
      type: 3,
      custom_id: 'select_class_role',
      placeholder: '🔮 Choose Class...',
      options: [
        { label: 'Oracle (Shield & Static Bonus)', value: 'oracle', emoji: { name: '🔮' } },
        { label: 'Renegade (Underdog Ticket Multiplier)', value: 'renegade', emoji: { name: '🏴‍☠️' } },
        { label: 'Tank (Loss Insurance & Fine Protection)', value: 'tank', emoji: { name: '🛡️' } },
        { label: 'Syndicate (Co-op Victory Pact)', value: 'syndicate', emoji: { name: '🤝' } },
        { label: 'Investigator (Investigation & Shield)', value: 'investigator', emoji: { name: '🔍' } }
      ]
    }]
  };

  const partnerId = await getConfigValue(`partner:${user.discord_id}`);
  const linkButtonDisabled = !!partnerId && partnerId !== 'Unlinked';

  const rowButtons = {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: 'Toggle Shield (Oracle)',
        custom_id: 'toggle_oracle_shield',
        disabled: userClass !== 'oracle'
      },
      {
        type: 2,
        style: 2,
        label: 'Link Co-op Partner',
        custom_id: 'link_syndicate_prompt',
        disabled: linkButtonDisabled
      }
    ]
  };

  return { embeds: [embed], components: [rowSelect, rowButtons] };
}

async function buildAdminHistoryPage(page = 1, sortBy = 'date_asc') {
  const { data: bets, error } = await supabase
    .from('bets')
    .select(`
      *,
      users ( username, display_name ),
      matches ( home_team, away_team, kickoff_time, status, winner )
    `, { count: 'exact' });

  if (error || !bets) {
    console.error('[Database Error in History Panel]:', error);
    throw new Error('Failed to retrieve history logs.');
  }

  let sorted = [...bets];
  if (sortBy === 'date_desc') {
    sorted.sort((a, b) => new Date(b.matches?.kickoff_time) - new Date(a.matches?.kickoff_time));
  } else if (sortBy === 'date_asc') {
    sorted.sort((a, b) => new Date(a.matches?.kickoff_time) - new Date(b.matches?.kickoff_time));
  } else if (sortBy === 'user_asc') {
    sorted.sort((a, b) => (a.users?.display_name || '').localeCompare(b.users?.display_name || ''));
  } else if (sortBy === 'unsettled') {
    sorted = sorted.filter(b => !b.settled);
  } else if (sortBy === 'settled') {
    sorted = sorted.filter(b => b.settled);
  }

  const itemsPerPage = 5;
  const totalPages = Math.max(1, Math.ceil(sorted.length / itemsPerPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pageItems = sorted.slice(startIndex, startIndex + itemsPerPage);

  const lines = pageItems.map((b, idx) => {
    const player = b.users?.display_name || b.users?.username || 'Unknown';
    const isFree = b.amount_wagered === 0;
    const wagerStr = isFree ? 'Free Vote' : `${fmt(b.amount_wagered)} 🪙`;
    
    const homeTeamName = b.matches?.home_team || 'Unknown';
    const awayTeamName = b.matches?.away_team || 'Unknown';
    const homeFlag = getFlag(b.matches?.home_team);
    const awayFlag = getFlag(b.matches?.away_team);
    
    const kickoff = b.matches?.kickoff_time;
    const dateLabel = kickoff
      ? new Date(kickoff).toLocaleDateString('en-US', {
          timeZone: 'America/New_York', month: 'short', day: 'numeric'
        })
      : 'No Date';

    const displayPick = b.team_picked === 'home'
      ? shortenTeamName(homeTeamName)
      : b.team_picked === 'away'
        ? shortenTeamName(awayTeamName)
        : 'DRAW';

    let statusLabel = '';
    if (b.settled) {
      const won = b.team_picked === b.matches?.winner;
      const isRefund = b.matches?.winner === 'draw' && b.team_picked !== 'draw';
      statusLabel = isRefund ? '↩️ Refunded' : won ? '✅ Won' : '❌ Lost';
    } else {
      const isLive = b.matches?.status === 'LIVE';
      statusLabel = isLive ? '🔴 LIVE' : '⏳ Pending';
    }

    return `\`#${startIndex + idx + 1}\` **${player}** • ${dateLabel}\n` +
           `${homeFlag} **${homeTeamName}** vs **${awayTeamName}** ${awayFlag}\n` +
           `   Pick: **${displayPick.toUpperCase()}** • Wager: **${wagerStr}** • **${statusLabel}**`;
  });

  const embed = {
    color: COLORS.blue,
    title: '📊  Global Betting Logs  •  Admin Console',
    description: `Current Filter: \`${sortBy.replace('_', ' ').toUpperCase()}\`\n\n` + 
                 (lines.join('\n\n') || '*No wagers match the selected filter.*'),
    footer: { text: `Page ${currentPage} of ${totalPages}  •  Click buttons below to navigate` },
    timestamp: new Date().toISOString()
  };

  const row1 = {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: 'Previous',
        custom_id: `admin_history_page:${currentPage - 1}:${sortBy}`,
        disabled: currentPage <= 1,
        emoji: { name: '⬅️' }
      },
      {
        type: 2,
        style: 2,
        label: 'Next',
        custom_id: `admin_history_page:${currentPage + 1}:${sortBy}`,
        disabled: currentPage >= totalPages,
        emoji: { name: '➡️' }
      }
    ]
  };

  const row2 = {
    type: 1,
    components: [{
      type: 3,
      custom_id: `admin_history_sort:${currentPage}`,
      placeholder: '⚙️  Sort & Filter logs...',
      options: [
        { label: 'Sort by Match Date (Oldest to Newest)', value: 'date_asc', emoji: { name: '📅' }, default: sortBy === 'date_asc' },
        { label: 'Sort by Match Date (Newest to Oldest)', value: 'date_desc', emoji: { name: '📅' }, default: sortBy === 'date_desc' },
        { label: 'Group by Player (A-Z)', value: 'user_asc', emoji: { name: '👤' }, default: sortBy === 'user_asc' },
        { label: 'Show Unsettled Only', value: 'unsettled', emoji: { name: '⏳' }, default: sortBy === 'unsettled' },
        { label: 'Show Settled Only', value: 'settled', emoji: { name: '✅' }, default: sortBy === 'settled' }
      ]
    }]
  };

  return { embeds: [embed], components: [row1, row2] };
}

module.exports = {
  COLORS,
  fmt,
  modal,
  buildMasterPanel,
  buildMatchDetail,
  buildBetConfirmEmbed,
  buildProfileEmbed,
  buildAdminHistoryPage
};