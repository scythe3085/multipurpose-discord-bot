// systems/vc/privacy.js
// Privacy-mode logic: the 3-state public/friends/private cycle, its styling
// helpers, and applyPrivacy() which edits only the overwrites we manage.
const { PermissionFlagsBits, ButtonStyle } = require('discord.js');
const vcPrefs = require('../vcPrefs.js');
const { tempVoiceChannels } = require('./state.js');

const COLOR_PUBLIC = 0x57f287;
const COLOR_FRIENDS = 0xfee75c;
const COLOR_PRIVATE = 0xed4245;

const PRIVACY_ORDER = ['public', 'friends', 'private'];

function nextPrivacy(current) {
  const i = PRIVACY_ORDER.indexOf(current);
  return PRIVACY_ORDER[(i + 1) % PRIVACY_ORDER.length];
}

function privacyAccentColor(mode) {
  if (mode === 'public') return COLOR_PUBLIC;
  if (mode === 'friends') return COLOR_FRIENDS;
  return COLOR_PRIVATE;
}

function privacyButtonLabel(mode) {
  if (mode === 'public') return '🔓 Public ↻';
  if (mode === 'friends') return '🤝 Friends-only ↻';
  return '🔒 Private ↻';
}

function privacyButtonStyle(mode) {
  if (mode === 'public') return ButtonStyle.Success;
  if (mode === 'friends') return ButtonStyle.Primary;
  return ButtonStyle.Danger;
}

function privacyStatusBadge(mode) {
  if (mode === 'public') return { emoji: '🔓', word: 'Public' };
  if (mode === 'friends') return { emoji: '🤝', word: 'Friends-only' };
  return { emoji: '🔒', word: 'Private' };
}

function isEveryoneDenied(voiceChannel, guild) {
  const everyoneOverwrite = voiceChannel.permissionOverwrites.cache.get(guild.id);
  return everyoneOverwrite ? everyoneOverwrite.deny.has(PermissionFlagsBits.Connect) : false;
}

/**
 * Apply a privacy mode to the VC by editing only the overwrites we manage.
 * Untouched: explicit /voice invite allows, role-level perms, anything we don't know about.
 */
async function applyPrivacy(voiceChannel, guild, meta, mode) {
  const everyone = guild.roles.everyone;
  const friendIds = vcPrefs.getFriends(guild.id, meta.ownerId);

  if (mode === 'public') {
    await voiceChannel.permissionOverwrites
      .edit(everyone, { Connect: true })
      .catch(err => console.error('Privacy public: everyone overwrite failed:', err));

    // Clear owner / co-owner explicit Connect — they fall back to allowed via @everyone
    await voiceChannel.permissionOverwrites.edit(meta.ownerId, { Connect: null }).catch(() => {});
    for (const coId of meta.coOwners) {
      await voiceChannel.permissionOverwrites.edit(coId, { Connect: null }).catch(() => {});
    }

    // Clear friend allows (they don't need them when public)
    for (const fid of friendIds) {
      if (meta.banned.has(fid)) continue;
      if (fid === meta.ownerId || meta.coOwners.has(fid)) continue;
      await voiceChannel.permissionOverwrites
        .edit(fid, { Connect: null, ViewChannel: null })
        .catch(() => {});
    }
  } else {
    // friends or private — both deny @everyone
    await voiceChannel.permissionOverwrites
      .edit(everyone, { Connect: false })
      .catch(err => console.error('Privacy lock: everyone overwrite failed:', err));

    // Owner + co-owners always allowed when locked
    await voiceChannel.permissionOverwrites
      .edit(meta.ownerId, { Connect: true, ViewChannel: true })
      .catch(() => {});
    for (const coId of meta.coOwners) {
      await voiceChannel.permissionOverwrites
        .edit(coId, { Connect: true, ViewChannel: true })
        .catch(() => {});
    }

    for (const fid of friendIds) {
      if (meta.banned.has(fid)) continue; // block list always wins
      if (fid === meta.ownerId || meta.coOwners.has(fid)) continue; // already handled
      if (mode === 'friends') {
        await voiceChannel.permissionOverwrites
          .edit(fid, { Connect: true, ViewChannel: true })
          .catch(() => {});
      } else {
        // private — friends are NOT auto-allowed
        await voiceChannel.permissionOverwrites
          .edit(fid, { Connect: null, ViewChannel: null })
          .catch(() => {});
      }
    }
  }

  meta.privacy = mode;
  tempVoiceChannels.set(voiceChannel.id, meta);
}

module.exports = {
  nextPrivacy,
  privacyAccentColor,
  privacyButtonLabel,
  privacyButtonStyle,
  privacyStatusBadge,
  isEveryoneDenied,
  applyPrivacy,
};
