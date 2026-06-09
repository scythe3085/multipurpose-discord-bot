const { Client, Collection, GatewayIntentBits, Events, MessageFlags } = require('discord.js');

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

// ====== DYNAMIC GUILD WHITELIST ======
// Single shared source of truth, also used by /add and /removeguild.
const whitelist = require('./systems/whitelist.js');

// ====== SYSTEM HANDLERS ======
const { handleTicketComponentOrModal } = require('./systems/tickets');
const { handleVoiceStateUpdate, handleVcInteraction, initVcSystem } = require('./systems/vc');
const { handleVerifyInteraction } = require('./systems/verify.js');

// ---- Alerts System (NEW) ----
const { initAlertsSystem, handleAlertsInteraction } = require('./systems/alerts/alerts.js');

// ====== CLIENT SETUP ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    // MessageContent (privileged) is kept: REST-fetched thread messages only
    // populate .content for the ticket transcript when it's granted. The
    // GuildMessages gateway intent was removed — nothing listens for live
    // messages, so streaming every guild message was pure wasted bandwidth.
    GatewayIntentBits.MessageContent,
  ],
});

// ====== LOAD COMMANDS ======
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.log(`\u26A0\uFE0F The command at ${filePath} is missing "data" or "execute".`);
  }
}

// ====== BOT READY ======
client.once(Events.ClientReady, async c => {
  console.log(`\u2705 Logged in as ${c.user.tag}`);

  try {
    await initVcSystem(c);
    console.log('\u2705 VC system initialised after startup.');
  } catch (err) {
    console.error('\u26A0\uFE0F Failed to initialise VC system:', err);
  }

  // ---- Alerts init (NEW) ----
  try {
    await initAlertsSystem(c);
    console.log('\u2705 Alerts system initialised after startup.');
  } catch (err) {
    console.error('\u26A0\uFE0F Failed to initialise Alerts system:', err);
  }
});

// ====== GUILD WHITELIST PROTECTION ======
client.on('guildCreate', guild => {
  if (!whitelist.isAllowed(guild.id)) {
    console.log(
      `\u26A0\uFE0F Joined unauthorized guild: ${guild.name} (${guild.id}) \u2014 leaving.`,
    );

    guild
      .leave()
      .catch(err => console.error('\u26A0\uFE0F Failed to leave unauthorized guild:', err));
  } else {
    console.log(`\u2705 Joined allowed guild: ${guild.name} (${guild.id})`);
  }
});

// ====== INTERACTION ROUTER ======
// Component & modal interactions (buttons, select menus, modal submits) are
// dispatched by their customId prefix. Each system owns a unique customId
// namespace, so the prefix alone identifies the handler — there's no need to
// also gate on the component type. Routes are tried in order; first match wins.
// (vc_member_ and vc_coowner_manage both start with vc_, so one prefix covers
// every VC control.)
const componentRoutes = [
  { match: id => id.startsWith('alerts_roles:'), handle: handleAlertsInteraction },
  { match: id => id.startsWith('ticket_'), handle: handleTicketComponentOrModal },
  { match: id => id.startsWith('vc_'), handle: handleVcInteraction },
  // Covers the panel button (config-driven customId, defaults to 'verify_button')
  // and the verify_word_modal: challenge — both live in the verify_ namespace.
  { match: id => id.startsWith('verify_'), handle: handleVerifyInteraction },
];

client.on(Events.InteractionCreate, async interaction => {
  try {
    // -------- Slash Commands --------
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    // -------- Components & Modals --------
    const customId = interaction.customId || '';
    const route = componentRoutes.find(r => r.match(customId));
    if (route) {
      await route.handle(interaction);
      return;
    }
  } catch (error) {
    console.error('Interaction error:', error);

    try {
      const payload = {
        content: '\u26A0\uFE0F There was an error while executing this interaction!',
        flags: MessageFlags.Ephemeral,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (e) {
      console.error('\u26A0\uFE0F Failed to send error reply:', e);
    }
  }
});

// ====== VOICE STATE UPDATES ======
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  await handleVoiceStateUpdate(oldState, newState);
});

// ====== ERROR LOGGING ======
client.on('error', err => {
  console.error('\u26A0\uFE0F Client error:', err);
});

// ====== LOGIN ======
client.login(process.env.DISCORD_TOKEN);
