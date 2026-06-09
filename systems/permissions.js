// systems/permissions.js
// Centralised permission checks so the rules live in one place.
//
// - Owner is the single bot operator, read from process.env.OWNER_ID (no longer
//   a hardcoded snowflake in command files — that value is also in git history,
//   which matters for open-sourcing).
// - "Manager" = anyone who can Manage Server, or an Administrator.
// - "Admin"   = Administrator only.

const { PermissionFlagsBits } = require('discord.js');

/** The configured owner user id, or '' if OWNER_ID is unset. */
function getOwnerId() {
  return (process.env.OWNER_ID || '').trim();
}

function isOwner(userId) {
  const owner = getOwnerId();
  return owner !== '' && String(userId) === owner;
}

function isAdmin(member) {
  return !!member?.permissions?.has?.(PermissionFlagsBits.Administrator);
}

function isManager(member) {
  return !!member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) || isAdmin(member);
}

module.exports = { getOwnerId, isOwner, isAdmin, isManager };
