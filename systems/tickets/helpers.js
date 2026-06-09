// systems/tickets/helpers.js
// Cooldown tracking, the log-embed helper, and ticket permission checks.
const { PermissionFlagsBits } = require('discord.js');
const config = require('../../config/tickets.config.js');
const guildConfig = require('../guildConfig.js');
const { sendLogEmbed } = require('../logEmbed.js');

const TICKET_LOG_FOOTER = 'Ticket system';

// userId -> timestamp (cooldown to prevent ticket spam)
const lastTicketOpen = new Map();

function isOnCooldown(userId) {
  const last = lastTicketOpen.get(userId) ?? 0;
  return Date.now() - last < config.COOLDOWN_MS;
}

function markCooldown(userId) {
  lastTicketOpen.set(userId, Date.now());
}

async function logTicket(guild, opts) {
  const tc = guildConfig.getTicketConfig(guild.id);
  const logChannelId = tc.logChannelId;
  if (!logChannelId) return;
  const logChannel = guild.channels.cache.get(logChannelId);
  await sendLogEmbed(logChannel, { ...opts, footer: TICKET_LOG_FOOTER });
}

function getStaffRoleIds(guildId) {
  const tc = guildConfig.getTicketConfig(guildId);
  return [tc.ownerRoleId, tc.twitchModRoleId, tc.discordModRoleId].filter(Boolean);
}

function isTicketStaff(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const staffRoleIds = getStaffRoleIds(member.guild.id);
  if (!staffRoleIds.length) return false;
  return member.roles.cache.some(r => staffRoleIds.includes(r.id));
}

function getDepartmentRolesForGuild(guildId, departmentKey) {
  const tc = guildConfig.getTicketConfig(guildId);
  const ids = [];
  if (departmentKey === 'contact_owner' && tc.ownerRoleId) ids.push(tc.ownerRoleId);
  if (departmentKey === 'contact_twitch_mod' && tc.twitchModRoleId) ids.push(tc.twitchModRoleId);
  if (departmentKey === 'contact_discord_mod' && tc.discordModRoleId) ids.push(tc.discordModRoleId);
  return ids;
}

// Reopen is restricted to the SAME role(s) that get pinged when the ticket is
// opened (admins always allowed). Other ticket actions (claim, close, add
// user) stay open to any staff role since multi-team escalation is common.
function isDeptStaff(member, departmentKey) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const deptRoleIds = getDepartmentRolesForGuild(member.guild.id, departmentKey);
  if (!deptRoleIds.length) {
    // No dept role configured for this guild — fall back to any staff so the
    // feature still works on guilds that haven't completed quick-setup.
    return isTicketStaff(member);
  }
  return member.roles.cache.some(r => deptRoleIds.includes(r.id));
}

module.exports = {
  lastTicketOpen,
  isOnCooldown,
  markCooldown,
  logTicket,
  getStaffRoleIds,
  isTicketStaff,
  getDepartmentRolesForGuild,
  isDeptStaff,
};
