// systems/vcPrefs.js
// Persistent per-user VC preferences (like blocklists), stored in JSON.

const path = require('node:path');
const { createJsonStore } = require('./store.js');

const PREFS_PATH = path.join(__dirname, '..', 'config', 'vc-prefs.json');
const store = createJsonStore(PREFS_PATH);

// Live backing object + persistence, shared with the store. The per-user
// nested-mutation helpers below operate on `data` directly then call save().
const data = store.all();
function save() {
  store.save();
}

function ensureGuildUser(guildId, userId) {
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) data[guildId][userId] = { blockedUserIds: [], friendUserIds: [] };
  const entry = data[guildId][userId];
  if (!Array.isArray(entry.blockedUserIds)) entry.blockedUserIds = [];
  if (!Array.isArray(entry.friendUserIds)) entry.friendUserIds = [];
  return entry;
}

function getBlockedUsers(guildId, userId) {
  if (!guildId || !userId) return [];
  const entry = (data[guildId] && data[guildId][userId]) || null;
  return entry && Array.isArray(entry.blockedUserIds) ? entry.blockedUserIds.slice() : [];
}

function addBlockedUser(guildId, ownerId, targetId) {
  if (!guildId || !ownerId || !targetId) return;
  const entry = ensureGuildUser(guildId, ownerId);
  if (!entry.blockedUserIds.includes(targetId)) {
    entry.blockedUserIds.push(targetId);
    save();
  }
}

function removeBlockedUser(guildId, ownerId, targetId) {
  if (!guildId || !ownerId || !targetId) return;
  const entry = ensureGuildUser(guildId, ownerId);
  const before = entry.blockedUserIds.length;
  entry.blockedUserIds = entry.blockedUserIds.filter(id => id !== targetId);
  if (entry.blockedUserIds.length !== before) {
    save();
  }
}

// ---- Friends list (inverse of blocklist; bypasses Friends-only privacy lock) ----

function getFriends(guildId, userId) {
  if (!guildId || !userId) return [];
  const entry = (data[guildId] && data[guildId][userId]) || null;
  return entry && Array.isArray(entry.friendUserIds) ? entry.friendUserIds.slice() : [];
}

function addFriend(guildId, ownerId, targetId) {
  if (!guildId || !ownerId || !targetId) return false;
  const entry = ensureGuildUser(guildId, ownerId);
  if (entry.friendUserIds.includes(targetId)) return false;
  entry.friendUserIds.push(targetId);
  save();
  return true;
}

function removeFriend(guildId, ownerId, targetId) {
  if (!guildId || !ownerId || !targetId) return false;
  const entry = ensureGuildUser(guildId, ownerId);
  const before = entry.friendUserIds.length;
  entry.friendUserIds = entry.friendUserIds.filter(id => id !== targetId);
  if (entry.friendUserIds.length === before) return false;
  save();
  return true;
}

// ---- VC profile (auto-save of name / userLimit / locked) ----
// Default `enabled: false` — opt-in. Toggling off keeps the saved profile so
// flipping it back on restores the user's previous settings.

const VALID_PRIVACY = new Set(['public', 'friends', 'private']);

function normalizePrivacy(p) {
  // New field wins; otherwise derive from legacy `locked` so existing profiles
  // keep working without a migration step.
  if (typeof p?.privacy === 'string' && VALID_PRIVACY.has(p.privacy)) return p.privacy;
  if (p?.locked === true) return 'private';
  if (p?.locked === false) return 'public';
  return undefined;
}

function getProfile(guildId, userId) {
  if (!guildId || !userId) return { enabled: false };
  const entry = (data[guildId] && data[guildId][userId]) || null;
  const p = entry?.profile;
  if (!p || typeof p !== 'object') return { enabled: false };
  return {
    enabled: p.enabled === true,
    name: typeof p.name === 'string' ? p.name : undefined,
    userLimit: Number.isInteger(p.userLimit) ? p.userLimit : undefined,
    privacy: normalizePrivacy(p),
  };
}

function isProfileEnabled(guildId, userId) {
  return getProfile(guildId, userId).enabled === true;
}

function patchProfile(guildId, userId, patch) {
  if (!guildId || !userId || !patch || typeof patch !== 'object') return;
  const entry = ensureGuildUser(guildId, userId);
  if (!entry.profile || typeof entry.profile !== 'object') {
    entry.profile = { enabled: false };
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    entry.profile[k] = v;
  }
  save();
}

function setProfileEnabled(guildId, userId, enabled) {
  patchProfile(guildId, userId, { enabled: !!enabled });
}

module.exports = {
  getBlockedUsers,
  addBlockedUser,
  removeBlockedUser,
  getFriends,
  addFriend,
  removeFriend,
  getProfile,
  isProfileEnabled,
  patchProfile,
  setProfileEnabled,
};
