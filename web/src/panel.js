/**
 * bot/index.js
 *
 * Persistent Bot Event Loop — suitable for JustRunMy.App or other running processes.
 */

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
require('dotenv').config();

const {
  getOrCreateUser,
  getActiveMatches,
  getSpyMetric,
  calculateEstimatedEarnings,
  placeBet,
  getUserHistory,
  savePanelMessage,
  getPanelMessage
} = require('./src/database');
const { syncFixtures, syncMockFixtures } = require('./src/footballApi');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

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

function progressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function fmt(n) {
  return n.toLocaleString();
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

  const embed = new EmbedBuilder()
    .setColor(0x1a6bff)
    .setTitle('🏆  Project Blue-Lock  •  World Cup 2026')
    .setDescription(
      '> Use fake tokens to predict real match outcomes.\n' +
      '> The bigger the upset, the bigger the jackpot.\n' +
      '\u200b'
    )
    .setFooter({ text: `🕒 Last updated · ${aestTime} AEST  •  Use /profile to view your wallet` })
    .setTimestamp();

  if (upcomingMatches.length === 0) {
    embed.addFields({
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

      embed.addFields({
        name: `📅  ${day}'s Matches`,
        value: lines.join('\n')
      });
    }
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_match')
    .setPlaceholder('⚽  Select a match to place or edit your prediction...');

  if (upcomingMatches.length > 0) {
    upcomingMatches.slice(0, 25).forEach(m => {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(`${m.home_team} vs ${m.away_team}`)
          .setValue(m.fixture_id)
          .setDescription(
            new Date(m.kickoff_time).toLocaleTimeString('en-AU', {
              timeZone: 'Australia/Sydney',
              hour: '2-digit', minute: '2-digit', hour12: true
            }) + ' AEST'
          )
          .setEmoji('⚽')
      );
    });
  } else {
    selectMenu.setDisabled(true).addOptions(
      new StringSelectMenuOptionBuilder().setLabel('No matches available').setValue('none')
    );
  }

  const row1 = new ActionRowBuilder().addComponents(selectMenu);

  const btnHistory = new ButtonBuilder()
    .setCustomId('view_my_history')
    .setLabel('My Predictions')
    .setEmoji('📊')
    .setStyle(ButtonStyle.Secondary);

  const btnRules = new ButtonBuilder()
    .setCustomId('show_rules')
    .setLabel('How to Play')
    .setEmoji('📖')
    .setStyle(ButtonStyle.Secondary);

  const row2 = new ActionRowBuilder().addComponents(btnHistory, btnRules);

  return { embeds: [embed], components: [row1, row2] };
}

async function refreshPanel() {
  try {
    const config = await getPanelMessage();
    if (!config) return;

    const channel = await client.channels.fetch(config.channelId);
    if (!channel) return;

    const message = await channel.messages.fetch(config.messageId);
    if (!message) return;

    const panelData = await buildMasterPanel();
    await message.edit(panelData);
  } catch (err) {
    console.warn('Panel auto-refresh skipped:', err.message);
  }
}

client.once('ready', async () => {
  console.log(`🤖  Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('setup-panel')
      .setDescription('Post the Blue-Lock Master Events Panel in this channel.'),
    new SlashCommandBuilder()
      .setName('sync-matches')
      .setDescription('Sync World Cup fixtures from API-Football into the database.')
      .addBooleanOption(opt =>
        opt.setName('mock')
          .setDescription('Use mock match data instead of live API-Football feed')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('View your token balance and prediction history.')
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('✅  Guild slash commands registered.');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅  Global slash commands registered.');
    }
  } catch (err) {
    console.error('❌  Failed to register slash commands:', err);
  }
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'setup-panel') {
      await interaction.deferReply();
      try {
        const panelData = await buildMasterPanel();
        const msg = await interaction.editReply(panelData);
        await savePanelMessage(msg.channelId, msg.id);
        console.log(`✅  Panel saved — Channel: ${msg.channelId} | Message: ${msg.id}`);
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌  Failed to build the panel. Check console logs.' });
      }
    }

    if (commandName === 'sync-matches') {
      await interaction.deferReply({ ephemeral: true });
      const useMock = interaction.options.getBoolean('mock') ?? false;
      try {
        const result = useMock ? await syncMockFixtures() : await syncFixtures();
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x00cc66)
              .setTitle('✅  Sync Successful')
              .setDescription(`${result.message}`)
              .setTimestamp()
          ]
        });
        await refreshPanel();
      } catch (err) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff3333)
              .setTitle('❌  Sync Failed')
              .setDescription(`\`\`\`\n${err.message}\n\`\`\``)
          ]
        });
      }
    }

    if (commandName === 'profile') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const user = await getOrCreateUser(interaction.user);
        const history = await getUserHistory(interaction.user.id);

        const activeBets = history.filter(b => b.matches && b.matches.status === 'NS');
        const pastBets = history.filter(b => b.matches && b.matches.status !== 'NS' && b.matches.winner);

        const wins = pastBets.filter(b => b.team_picked === b.matches.winner).length;
        const refunds = pastBets.filter(b => b.matches.winner === 'draw' && b.team_picked !== 'draw').length;
        const losses = pastBets.length - wins - refunds;
        const accuracy = pastBets.length > 0 ? Math.round((wins / pastBets.length) * 100) : 0;

        const embed = new EmbedBuilder()
          .setColor(0x1a6bff)
          .setTitle(`${user.display_name || user.username}`)
          .setDescription(
            `> <@${user.discord_id}>\n\u200b`
          )
          .setThumbnail(user.avatar_url || interaction.user.displayAvatarURL())
          .addFields(
            {
              name: '💰  Wallet',
              value: `\`\`\`\n${fmt(user.tokens_balance)} tokens\n\`\`\``,
              inline: true
            },
            {
              name: '🏆  Win Rate',
              value: `\`\`\`\n${wins}W / ${losses}L / ${refunds}R (${accuracy}%)\n\`\`\``,
              inline: true
            }
          );

        if (activeBets.length > 0) {
          const list = activeBets.map(b => {
            const displayPick = b.team_picked === 'home' 
              ? b.matches.home_team 
              : b.team_picked === 'away' 
                ? b.matches.away_team 
                : 'DRAW';
            return `⚽ **${b.matches.home_team} vs ${b.matches.away_team}**\n` +
                   `   Picked: **${displayPick.toUpperCase()}**  •  Wager: **${fmt(b.amount_wagered)}🪙**`;
          }).join('\n\n');
          embed.addFields({ name: '\u200b\n🕒  Active Wagers', value: list });
        }

        if (pastBets.length > 0) {
          const lines = pastBets.slice(-5).reverse().map(b => {
            if (b.matches.winner === 'draw' && b.team_picked !== 'draw') {
              return `↩️  **${b.matches.home_team} vs ${b.matches.away_team}**  •  Refunded (${fmt(b.amount_wagered)}🪙)`;
            }
            const displayPick = b.team_picked === 'home' 
              ? b.matches.home_team 
              : b.team_picked === 'away' 
                ? b.matches.away_team 
                : 'DRAW';
            const won = b.team_picked === b.matches.winner;
            return `${won ? '✅' : '❌'}  **${b.matches.home_team} vs ${b.matches.away_team}**  •  ${displayPick.toUpperCase()}  (${fmt(b.amount_wagered)}🪙)`;
          }).join('\n');
          embed.addFields({ name: '\u200b\n📜  Recent Results', value: lines });
        }

        embed.setFooter({ text: 'Use the dropdown in the events panel to place a bet' }).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌  Failed to load profile.' });
      }
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_match') {
      const fixtureId = interaction.values[0];
      if (fixtureId === 'none') return interaction.deferUpdate();

      await interaction.deferReply({ ephemeral: true });
      try {
        const user = await getOrCreateUser(interaction.user);
        const matches = await getActiveMatches();
        const match = matches.find(m => m.fixture_id === fixtureId);
        if (!match) return await interaction.editReply({ content: '❌  Match not found.' });

        const spy = await getSpyMetric(fixtureId);
        const total = spy.totalVotes || 0;

        const homeShare = total > 0 ? Math.round((spy.home.votes / total) * 100) : 33;
        const awayShare = total > 0 ? Math.round((spy.away.votes / total) * 100) : 33;
        const drawShare = 100 - homeShare - awayShare;

        const unixTs = Math.floor(new Date(match.kickoff_time).getTime() / 1000);

        const embed = new EmbedBuilder()
          .setColor(0x1a6bff)
          .setTitle(`⚽  ${match.home_team}  🆚  ${match.away_team}`)
          .setDescription(
            `**Kickoff:** <t:${unixTs}:F> (<t:${unixTs}:R>)\n\u200b`
          )
          .addFields(
            {
              name: '💰  Your Wallet',
              value: `\`${fmt(user.tokens_balance)} tokens\``,
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
          )
          .setFooter({ text: 'Select your prediction below. You can change it before kickoff.' })
          .setTimestamp();

        const predictionMenu = new StringSelectMenuBuilder()
          .setCustomId(`select_prediction:${fixtureId}`)
          .setPlaceholder('🔮  Choose your prediction...')
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(`${match.home_team} Win`)
              .setValue('home')
              .setEmoji('⚽'),
            new StringSelectMenuOptionBuilder()
              .setLabel('Draw')
              .setValue('draw')
              .setEmoji('🤝'),
            new StringSelectMenuOptionBuilder()
              .setLabel(`${match.away_team} Win`)
              .setValue('away')
              .setEmoji('⚽')
          );

        const row = new ActionRowBuilder().addComponents(predictionMenu);
        await interaction.editReply({ embeds: [embed], components: [row] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌  Something went wrong. Try again.' });
      }
    }

    if (interaction.customId.startsWith('select_prediction:')) {
      const fixtureId = interaction.customId.split(':')[1];
      const prediction = interaction.values[0];

      const modal = new ModalBuilder()
        .setCustomId(`wager_modal:${fixtureId}:${prediction}`)
        .setTitle('Place Your Wager');

      const wagerInput = new TextInputBuilder()
        .setCustomId('wager_amount')
        .setLabel('How many tokens? (Enter 0 for a Free Vote)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 250')
        .setMinLength(1)
        .setMaxLength(6)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(wagerInput));
      await interaction.showModal(modal);
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('wager_modal:')) {
      await interaction.deferReply({ ephemeral: true });
      const [, fixtureId, teamPicked] = interaction.customId.split(':');
      const amountStr = interaction.fields.getTextInputValue('wager_amount');
      const amountWagered = parseInt(amountStr, 10);

      if (isNaN(amountWagered) || amountWagered < 0) {
        return await interaction.editReply({ content: '❌  Invalid amount. Enter a whole number ≥ 0.' });
      }

      try {
        const result = await placeBet(interaction.user.id, fixtureId, teamPicked, amountWagered);
        const estEarnings = await calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, interaction.user.id);
        const matches = await getActiveMatches();
        const match = matches.find(m => m.fixture_id === fixtureId);

        const isFreeVote = amountWagered === 0;
        const isUpdate = !!result.previousBet;

        const pickEmoji = { home: '⚽', draw: '🤝', away: '⚽' }[teamPicked] || '🔮';
        const displayPick = teamPicked === 'home' 
          ? match.home_team.toUpperCase() 
          : teamPicked === 'away' 
            ? match.away_team.toUpperCase() 
            : 'DRAW';

        const multiplierStr = isFreeVote
          ? 'Free Vote'
          : estEarnings.multiplier > 1.0
            ? `🔥 ${estEarnings.multiplier}x UNDERDOG BOOST`
            : `${estEarnings.multiplier}x`;

        const isHomeOrAway = teamPicked === 'home' || teamPicked === 'away';
        const refundNote = (!isFreeVote && isHomeOrAway) ? '\n*Note: If this match ends in a Draw, your wager will be fully refunded.*' : '';

        const embed = new EmbedBuilder()
          .setColor(isFreeVote ? 0x9b59b6 : 0x00cc66)
          .setTitle(isUpdate ? '🔄  Prediction Updated' : '✅  Prediction Locked In')
          .setDescription(
            `**${match.home_team}  🆚  ${match.away_team}**\n` +
            `<t:${Math.floor(new Date(match.kickoff_time).getTime() / 1000)}:R>\n\u200b` +
            refundNote
          )
          .addFields(
            {
              name: `${pickEmoji}  Your Pick`,
              value: `\`\`\`\n${displayPick}\n\`\`\``,
              inline: true
            },
            {
              name: '🪙  Wagered',
              value: `\`\`\`\n${isFreeVote ? 'Free Vote' : fmt(amountWagered) + ' tokens'}\n\`\`\``,
              inline: true
            },
            {
              name: '📈  Est. Return',
              value: `\`\`\`\n${isFreeVote ? '+5 tokens (if correct)' : fmt(estEarnings.estimated) + ' tokens'}\n\`\`\``,
              inline: true
            },
            {
              name: '⚡  Multiplier',
              value: multiplierStr,
              inline: true
            },
            {
              name: '💰  New Balance',
              value: `\`${fmt(result.newBalance)} tokens\``,
              inline: true
            }
          )
          .setFooter({ text: 'You can change your prediction any time before kickoff.' })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        await refreshPanel();
      } catch (err) {
        console.error(err);
        const embed = new EmbedBuilder()
          .setColor(0xff3333)
          .setTitle('❌  Wager Failed')
          .setDescription(`\`\`\`\n${err.message}\n\`\`\``);
        await interaction.editReply({ embeds: [embed] });
      }
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'view_my_history') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const user = await getOrCreateUser(interaction.user);
        const history = await getUserHistory(interaction.user.id);

        const activeBets = history.filter(b => b.matches && b.matches.status === 'NS');
        const pastBets = history.filter(b => b.matches && b.matches.winner);
        const wins = pastBets.filter(b => b.team_picked === b.matches.winner).length;
        const refunds = pastBets.filter(b => b.matches.winner === 'draw' && b.team_picked !== 'draw').length;
        const losses = pastBets.length - wins - refunds;

        const embed = new EmbedBuilder()
          .setColor(0x1a6bff)
          .setTitle(`${user.display_name || user.username}  •  Prediction History`)
          .setThumbnail(user.avatar_url || interaction.user.displayAvatarURL())
          .addFields({
            name: '💰  Balance',
            value: `\`${fmt(user.tokens_balance)} tokens\``,
            inline: true
          },
          {
            name: '🏆  Record',
            value: `\`${wins}W / ${losses}L / ${refunds}R\``,
            inline: true
          });

        if (activeBets.length > 0) {
          embed.addFields({
            name: '\u200b\n🕒  Active Wagers',
            value: activeBets.map(b => {
              const displayPick = b.team_picked === 'home' 
                ? b.matches.home_team 
                : b.team_picked === 'away' 
                  ? b.matches.away_team 
                  : 'DRAW';
              return `⚽ **${b.matches.home_team} vs ${b.matches.away_team}**\n` +
                     `   → **${displayPick.toUpperCase()}**  •  ${fmt(b.amount_wagered)}🪙`;
            }).join('\n\n')
          });
        } else {
          embed.addFields({ name: '\u200b\n🕒  Active Wagers', value: '*None yet — pick a match from the panel above!*' });
        }

        if (pastBets.length > 0) {
          const lines = pastBets.slice(-5).reverse().map(b => {
            if (b.matches.winner === 'draw' && b.team_picked !== 'draw') {
              return `↩️  **${b.matches.home_team} vs ${b.matches.away_team}**  •  Refunded (${fmt(b.amount_wagered)}🪙)`;
            }
            const displayPick = b.team_picked === 'home' 
              ? b.matches.home_team 
              : b.team_picked === 'away' 
                ? b.matches.away_team 
                : 'DRAW';
            const won = b.team_picked === b.matches.winner;
            return `${won ? '✅' : '❌'}  **${b.matches.home_team} vs ${b.matches.away_team}**  •  ${displayPick.toUpperCase()}  (${fmt(b.amount_wagered)}🪙)`;
          }).join('\n');
          embed.addFields({ name: '\u200b\n📜  Recent Results (Last 5)', value: lines });
        }

        embed.setFooter({ text: 'Use /profile for full stats' }).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌  Failed to load history.' });
      }
    }

    if (interaction.customId === 'show_rules') {
      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('📖  How to Play  •  Project Blue-Lock')
        .setDescription(
          '**You start with 500 tokens.** Predict match outcomes to win more.\n\u200b'
        )
        .addFields(
          {
            name: '1️⃣  Payout Formula',
            value:
              'Winners split the pool proportionally to what they wagered:\n' +
              '```\nPayout = (Boosted Pool ÷ Winning Tokens) × Your Bet + Base Reward\n```'
          },
          {
            name: '2️⃣  Upset Multipliers',
            value:
              '```\n> 80% vote share  →  1.0x  (favourite wins, no bonus)\n' +
              '50–80%           →  1.0x  (standard split)\n' +
              '20–50%           →  1.10x ⬆  (mild underdog)\n' +
              '< 20%            →  1.20x  🔥 (miracle jackpot)\n```'
          },
          {
            name: '3️⃣  Free Votes',
            value:
              'Wager **0 tokens** to submit a Free Vote.\n' +
              'Free votes don\'t dilute the main pool.\n' +
              'A correct Free Vote earns a flat **+5 tokens**.'
          },
          {
            name: '4️⃣  Base Rewards & Editing',
            value:
              'Winning bets receive a **Base Reward** (+5 tokens for bets < 20, +20 tokens for bets ≥ 20).\n' +
              'You can change your prediction **any time before kickoff**.\n' +
              'Just select the same match again — it will overwrite your previous pick.'
          }
        )
        .setFooter({ text: 'Good luck! 🍀' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

client.login(token).catch(err => {
  console.error('CRITICAL: Discord login failed. Check DISCORD_TOKEN in your .env file.\n', err.message);
});