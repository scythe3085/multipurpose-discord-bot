// systems/vc/state.js
// Shared in-memory state for the temp-VC system + tiny accessors. Every other
// vc/ module imports the Maps from here so they all see the same state.
const { PermissionFlagsBits } = require('discord.js');

// vcId -> { ownerId, coOwners: Set<string>, banned: Set<string>, panelMessageId, privacy }
const tempVoiceChannels = new Map();
// userId -> { vcId: string, pendingClear: boolean }
const vcOnlyMutes = new Map();
// userId -> timestamp (rate-limit for join-to-create)
const lastVcCreate = new Map();

async function logVcEvent(guild, text) {
  // VC logging disabled (stub)
  return;
}

function findOwnedTempVcForMember(member) {
  if (!member?.voice?.channelId) return null;

  const channel = member.guild.channels.cache.get(member.voice.channelId);
  if (!channel) return null;

  const meta = tempVoiceChannels.get(channel.id);
  if (!meta) return null;

  // ? make sure it's actually THEIR VC
  if (meta.ownerId !== member.id) return null;

  return { channel, meta };
}

function isController(interaction, meta) {
  const isOwner = meta.ownerId === interaction.user.id;
  const isCoOwner = meta.coOwners.has(interaction.user.id);
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  return isOwner || isCoOwner || isAdmin;
}

function getVcIdFromCustomId(customId) {
  return customId.split(':')[1];
}

module.exports = {
  tempVoiceChannels,
  vcOnlyMutes,
  lastVcCreate,
  logVcEvent,
  findOwnedTempVcForMember,
  isController,
  getVcIdFromCustomId,
};
