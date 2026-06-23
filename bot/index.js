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
  getUserHistory 
} = require('./src/database');
const { syncFixtures, syncMockFixtures } = require('./src/footballApi');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// Cache for temp user states (if needed)
const userSelections = new Map(); // userId -> { fixtureId, prediction }

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  
  // Register Slash Commands
  const commands = [
    new SlashCommandBuilder()
      .setName('setup-panel')
      .setDescription('Initializes the Project Blue-Lock Master Events Panel in the current channel.'),
    new SlashCommandBuilder()
      .setName('sync-matches')
      .setDescription('Sync World Cup matches from API-Football.')
      .addBooleanOption(option => 
        option.setName('mock')
          .setDescription('Use mock match data instead of calling live API-Football feed')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('View your tokens balance and active wagers.')
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('🔄 Started refreshing application (/) commands.');
    if (guildId) {
      // Fast guild registration for testing
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log('Successfully re-registered guild application (/) commands.');
    } else {
      // Global registration
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log('Successfully re-registered global application (/) commands.');
    }
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

// Helper to determine if a kickoff date is today or tomorrow in AEST/AEDT
function getAustralianDayLabel(kickoffStr) {
  // AEST (UTC+10) or AEDT (UTC+11). For general comparison:
  const kickoffDate = new Date(kickoffStr);
  
  // Convert current time and kickoff time to Australia/Sydney date strings
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const nowAussieStr = formatter.format(new Date());
  const kickoffAussieStr = formatter.format(kickoffDate);

  const nowAussie = new Date(nowAussieStr);
  const kickoffAussie = new Date(kickoffAussieStr);

  const diffTime = kickoffAussie - nowAussie;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return null;
}

/**
 * Build the Master Events Panel Embed and Components
 */
async function buildMasterPanel() {
  const matches = await getActiveMatches();
  
  // Filter for today/tomorrow matches in Sydney time
  const upcomingMatches = matches.filter(m => {
    if (m.status !== 'NS') return false; // Only not started matches
    const label = getAustralianDayLabel(m.kickoff_time);
    return label === 'Today' || label === 'Tomorrow';
  });

  const embed = new EmbedBuilder()
    .setTitle('🏆 Project Blue-Lock: World Cup Virtual Pool')
    .setDescription(
      'Wager fake tokens on real-world match outcomes!\n' +
      '👉 Select a match from the dropdown below to place or modify your prediction.'
    )
    .setColor('#0055ff') // Slate blue
    .setTimestamp();

  if (upcomingMatches.length === 0) {
    embed.addFields({ name: '⚽ Scheduled Matches', value: 'No upcoming matches scheduled for Today or Tomorrow (AEST/AEDT).' });
  } else {
    // Group by today / tomorrow
    const groups = { Today: [], Tomorrow: [] };
    upcomingMatches.forEach(m => {
      const label = getAustralianDayLabel(m.kickoff_time);
      if (groups[label]) groups[label].push(m);
    });

    for (const [day, dayMatches] of Object.entries(groups)) {
      if (dayMatches.length === 0) continue;
      
      const lines = [];
      for (const m of dayMatches) {
        // Fetch spy metric for live wager distribution representation
        const spy = await getSpyMetric(m.fixture_id);
        const homeVotes = spy.home.votes;
        const awayVotes = spy.away.votes;
        const drawVotes = spy.draw.votes;
        const total = spy.totalVotes || 1;

        const homeShare = Math.round((homeVotes / total) * 100);
        const awayShare = Math.round((awayVotes / total) * 100);
        const drawShare = Math.round((drawVotes / total) * 100);

        const spyString = spy.totalVotes > 0 
          ? `📊 *Spy:* H: ${homeShare}% | A: ${awayShare}% | D: ${drawShare}% (${spy.totalTokens} 🪙)`
          : `📊 *Spy:* No wagers placed yet`;

        const unixTimestamp = Math.floor(new Date(m.kickoff_time).getTime() / 1000);
        lines.push(`• **${m.home_team}** vs **${m.away_team}**\n  🕒 <t:${unixTimestamp}:F>\n  ${spyString}\n`);
      }
      embed.addFields({ name: `⚽ Matches ${day}`, value: lines.join('\n') });
    }
  }

  // Create Select Menu Options
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_match')
    .setPlaceholder('👉 Choose a match to bet on...');

  if (upcomingMatches.length > 0) {
    upcomingMatches.forEach(m => {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(`${m.home_team} vs ${m.away_team}`)
          .setValue(m.fixture_id)
          .setDescription(`Kickoff: ${new Date(m.kickoff_time).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit' })} AEST`)
      );
    });
  } else {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('No matches available')
        .setValue('none')
        .setDisabled(true)
    );
  }

  const row1 = new ActionRowBuilder().addComponents(selectMenu);

  const btnHistory = new ButtonBuilder()
    .setCustomId('view_my_history')
    .setLabel('👤 View My History')
    .setStyle(ButtonStyle.Secondary);

  const btnCalc = new ButtonBuilder()
    .setCustomId('show_rules')
    .setLabel('📖 Game Rules & Formulas')
    .setStyle(ButtonStyle.Secondary);

  const row2 = new ActionRowBuilder().addComponents(btnHistory, btnCalc);

  return { embeds: [embed], components: [row1, row2] };
}

client.on('interactionCreate', async interaction => {
  // Slash Commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'setup-panel') {
      await interaction.deferReply();
      try {
        const panelData = await buildMasterPanel();
        await interaction.editReply(panelData);
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌ Failed to build/setup the panel.' });
      }
    }

    if (commandName === 'sync-matches') {
      await interaction.deferReply({ ephemeral: true });
      const useMock = interaction.options.getBoolean('mock') ?? false;

      try {
        let result;
        if (useMock) {
          result = await syncMockFixtures();
        } else {
          result = await syncFixtures();
        }
        await interaction.editReply({ content: `✅ **Sync Successful:** ${result.message}` });
      } catch (err) {
        await interaction.editReply({ content: `❌ **Sync Failed:** ${err.message}` });
      }
    }

    if (commandName === 'profile') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const user = await getOrCreateUser(interaction.user);
        const history = await getUserHistory(interaction.user.id);
        
        const activeBets = history.filter(b => b.matches.status === 'NS');
        const pastBets = history.filter(b => b.matches.status !== 'NS');

        const embed = new EmbedBuilder()
          .setTitle(`👤 ${user.display_name || user.username}'s Profile`)
          .setDescription(`**Wallet Balance:** ${user.tokens_balance} 🪙 tokens`)
          .setColor('#0055ff')
          .setThumbnail(user.avatar_url || interaction.user.displayAvatarURL());

        if (activeBets.length > 0) {
          const list = activeBets.map(b => 
            `• **${b.matches.home_team}** vs **${b.matches.away_team}**: Predicted **${b.team_picked.toUpperCase()}** with **${b.amount_wagered}** 🪙`
          ).join('\n');
          embed.addFields({ name: '🕒 Active Wagers', value: list });
        } else {
          embed.addFields({ name: '🕒 Active Wagers', value: 'None' });
        }

        if (pastBets.length > 0) {
          const wins = pastBets.filter(b => b.team_picked === b.matches.winner).length;
          embed.addFields({ name: '📊 Win/Loss Stats', value: `Total Predictions: ${pastBets.length}\nAccuracy: ${Math.round((wins / pastBets.length) * 100)}% (${wins} wins)` });
        }

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌ Failed to load profile.' });
      }
    }
  }

  // Dropdowns (String Select Menus)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_match') {
      const fixtureId = interaction.values[0];
      if (fixtureId === 'none') return;

      await interaction.deferReply({ ephemeral: true });

      try {
        const user = await getOrCreateUser(interaction.user);
        // Find the match
        const matches = await getActiveMatches();
        const match = matches.find(m => m.fixture_id === fixtureId);

        if (!match) {
          return await interaction.editReply({ content: '❌ Match not found.' });
        }

        // Send confirmation/selection panel for this match
        const embed = new EmbedBuilder()
          .setTitle(`Prediction Phase: ${match.home_team} vs ${match.away_team}`)
          .setDescription(
            `Choose your prediction for this match.\n\n` +
            `**Your Balance:** ${user.tokens_balance} 🪙\n` +
            `**Kickoff Time:** <t:${Math.floor(new Date(match.kickoff_time).getTime() / 1000)}:F>`
          )
          .setColor('#0055ff');

        const selectPrediction = new StringSelectMenuBuilder()
          .setCustomId(`select_prediction:${fixtureId}`)
          .setPlaceholder('🔮 Select prediction (Home, Away, or Draw)...')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel(`Home: ${match.home_team}`).setValue('home'),
            new StringSelectMenuOptionBuilder().setLabel(`Away: ${match.away_team}`).setValue('away'),
            new StringSelectMenuOptionBuilder().setLabel('Draw').setValue('draw')
          );

        const row = new ActionRowBuilder().addComponents(selectPrediction);
        await interaction.editReply({ embeds: [embed], components: [row] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌ Something went wrong.' });
      }
    }

    if (interaction.customId.startsWith('select_prediction:')) {
      const fixtureId = interaction.customId.split(':')[1];
      const prediction = interaction.values[0];

      // Retrieve match details
      const matches = await getActiveMatches();
      const match = matches.find(m => m.fixture_id === fixtureId);

      if (!match) {
        return await interaction.reply({ content: '❌ Match not found.', ephemeral: true });
      }

      // Display Modal for amount
      const modal = new ModalBuilder()
        .setCustomId(`wager_modal:${fixtureId}:${prediction}`)
        .setTitle('Place Token Wager');

      const wagerInput = new TextInputBuilder()
        .setCustomId('wager_amount')
        .setLabel('Token Wager Amount (0 for Free Vote)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 250')
        .setRequired(true);

      const actionRow = new ActionRowBuilder().addComponents(wagerInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    }
  }

  // Modals Submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('wager_modal:')) {
      await interaction.deferReply({ ephemeral: true });
      const [, fixtureId, teamPicked] = interaction.customId.split(':');
      const amountStr = interaction.fields.getTextInputValue('wager_amount');
      const amountWagered = parseInt(amountStr, 10);

      if (isNaN(amountWagered) || amountWagered < 0) {
        return await interaction.editReply({ content: '❌ Invalid wager amount. Please enter a valid number >= 0.' });
      }

      try {
        const user = await getOrCreateUser(interaction.user);
        const result = await placeBet(interaction.user.id, fixtureId, teamPicked, amountWagered);

        // Fetch estimated earnings post-bet
        const estEarnings = await calculateEstimatedEarnings(fixtureId, teamPicked, amountWagered, interaction.user.id);
        const matches = await getActiveMatches();
        const match = matches.find(m => m.fixture_id === fixtureId);

        const embed = new EmbedBuilder()
          .setTitle('✅ Prediction Submitted')
          .setDescription(`Your prediction has been successfully recorded.`)
          .setColor('#00ff55') // Green Success
          .addFields(
            { name: '⚽ Fixture', value: `${match.home_team} vs ${match.away_team}` },
            { name: '🔮 Pick', value: teamPicked.toUpperCase(), inline: true },
            { name: '🪙 Wagered', value: amountWagered === 0 ? 'Free Vote (+5 on win)' : `${amountWagered} 🪙`, inline: true },
            { name: '📈 Est. Payout', value: amountWagered === 0 ? '5 🪙' : `${estEarnings.estimated} 🪙 (Multiplier: ${estEarnings.multiplier}x)`, inline: true },
            { name: '💰 New Balance', value: `${result.newBalance} 🪙` }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: `❌ **Failed to place bet:** ${err.message}` });
      }
    }
  }

  // Button Interactions
  if (interaction.isButton()) {
    if (interaction.customId === 'view_my_history') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const user = await getOrCreateUser(interaction.user);
        const history = await getUserHistory(interaction.user.id);
        
        const activeBets = history.filter(b => b.matches.status === 'NS');
        const pastBets = history.filter(b => b.matches.status !== 'NS');

        const embed = new EmbedBuilder()
          .setTitle(`👤 Prediction History - ${user.display_name || user.username}`)
          .setDescription(`**Wallet Balance:** ${user.tokens_balance} 🪙 tokens`)
          .setColor('#0055ff');

        if (activeBets.length > 0) {
          const list = activeBets.map(b => 
            `• **${b.matches.home_team}** vs **${b.matches.away_team}**: Predicted **${b.team_picked.toUpperCase()}** with **${b.amount_wagered}** 🪙`
          ).join('\n');
          embed.addFields({ name: '🕒 Active Predictions', value: list });
        } else {
          embed.addFields({ name: '🕒 Active Predictions', value: 'No current active predictions.' });
        }

        if (pastBets.length > 0) {
          const lines = pastBets.slice(-10).map(b => {
            const won = b.team_picked === b.matches.winner;
            const resultEmoji = won ? '✅' : '❌';
            return `${resultEmoji} **${b.matches.home_team}** vs **${b.matches.away_team}** (Picked ${b.team_picked.toUpperCase()}) - Wager: ${b.amount_wagered}`;
          }).join('\n');
          embed.addFields({ name: '📜 Recent History (Last 10)', value: lines });
        }

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌ Failed to load history.' });
      }
    }

    if (interaction.customId === 'show_rules') {
      const embed = new EmbedBuilder()
        .setTitle('🏆 Project Blue-Lock Game Rules')
        .setDescription(
          '**1. Payout Pool Split Formula**\n' +
          'All bets on a match go into a pool. Winners split the pool proportionally based on their wagers:\n' +
          '$$Payout = \\left(\\frac{Boosted Pool}{Winning Tokens}\\right) \\times Your Bet$$\n\n' +
          '**2. Anti-Inflation Multipliers**\n' +
          'To award high-risk strategies, underdog victories boost the total payout pool:\n' +
          '• **Favorite wins** (>80% vote share): **1.0x** pool\n' +
          '• **Standard wins** (50% - 80% share): **1.0x** pool\n' +
          '• **Mild Upsets** (20% - 50% share): **1.25x** pool boost\n' +
          '• **Miracle Jackpots** (<20% share): **1.5x** ultimate pool boost!\n\n' +
          '**3. Free Vote System**\n' +
          'If you bet **0 tokens**, it is a Free Vote. You do not dilute the pool, and a correct prediction awards a flat **+5 tokens**.'
        )
        .setColor('#ffd700'); // Gold

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

client.login(token).catch(err => {
  console.error('CRITICAL: Discord login failed. Verify DISCORD_TOKEN in environment configuration.', err);
});
