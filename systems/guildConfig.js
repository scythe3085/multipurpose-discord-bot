// systems/guildConfig.js
// Simple per-guild JSON-backed config so the bot can be used on any server.
// Each guild is fully isolated: config values (channels, roles, logs) are never
// shared across guilds.

const path = require('node:path');
const { createJsonStore } = require('./store.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'guild-config.json');
const store = createJsonStore(CONFIG_PATH);

// Shape:
// {
//   "<guildId>": {
//     ticketLogChannelId: string|null,
//     transcriptChannelId: string|null,
//     ticketOwnerRoleId: string|null,
//     ticketTwitchModRoleId: string|null,
//     ticketDiscordModRoleId: string|null,
//     verifyLogChannelId: string|null,
//     verifiedRoleId: string|null,
//     joinToCreateVcId: string|null,
//     vcCategoryId: string|null
//   },
//   ...
// }

function ensureGuild(guildId) {
  const data = store.all();
  if (!data[guildId]) {
    data[guildId] = {
      ticketLogChannelId: null,
      transcriptChannelId: null,
      ticketOwnerRoleId: null,
      ticketTwitchModRoleId: null,
      ticketDiscordModRoleId: null,
      verifyLogChannelId: null,
      verifiedRoleId: null,
      joinToCreateVcId: null,
      vcCategoryId: null,
    };
  }
  return data[guildId];
}

function getGuildConfig(guildId) {
  if (!guildId) return null;
  return ensureGuild(guildId);
}

function updateGuildConfig(guildId, patch) {
  if (!guildId) return null;
  const cfg = ensureGuild(guildId);
  Object.assign(cfg, patch);
  store.save();
  return cfg;
}

function getTicketConfig(guildId) {
  const g = getGuildConfig(guildId) || {};
  return {
    logChannelId: g.ticketLogChannelId || g.transcriptChannelId || null,
    // No fallback to the log channel: a full ticket transcript (the entire
    // private conversation) must never silently land in a general staff-log
    // channel. If no transcript channel is set, transcripts are simply skipped.
    transcriptChannelId: g.transcriptChannelId || null,
    ownerRoleId: g.ticketOwnerRoleId || null,
    twitchModRoleId: g.ticketTwitchModRoleId || null,
    discordModRoleId: g.ticketDiscordModRoleId || null,
  };
}

function getVerifyConfig(guildId) {
  const g = getGuildConfig(guildId) || {};
  return {
    logChannelId: g.verifyLogChannelId || g.ticketLogChannelId || null,
    verifiedRoleId: g.verifiedRoleId || null,
  };
}

function getVcConfig(guildId) {
  const g = getGuildConfig(guildId) || {};
  return {
    joinToCreateVcId: g.joinToCreateVcId || null,
    vcCategoryId: g.vcCategoryId || null,
  };
}

// Quick health check for /config show
function getConfigStatus(guildId) {
  const g = getGuildConfig(guildId) || {};
  const problems = [];

  if (!g.ticketLogChannelId) {
    problems.push('Ticket log channel is not set.');
  }
  if (!g.verifiedRoleId) {
    problems.push('Verified role is not set.');
  }
  if (!g.joinToCreateVcId) {
    problems.push('Join-to-Create VC is not set.');
  }
  if (!g.vcCategoryId) {
    problems.push('VC category is not set.');
  }
  if (!g.ticketOwnerRoleId && !g.ticketTwitchModRoleId && !g.ticketDiscordModRoleId) {
    problems.push('No ticket contact roles are configured.');
  }

  return problems;
}

module.exports = {
  getGuildConfig,
  updateGuildConfig,
  getTicketConfig,
  getVerifyConfig,
  getVcConfig,
  getConfigStatus,
};
