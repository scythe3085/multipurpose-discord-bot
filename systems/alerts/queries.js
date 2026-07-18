// systems/alerts/queries.js
// Every SQL statement for the alerts system lives here. The poller and the
// command handlers talk to the database only through these helpers — there are
// no raw db.prepare() calls anywhere else in the alerts code.

const db = require('./db.js');
const cfg = require('../../config/alerts.config.js');

function insertSubscription(row) {
  db.prepare(
    `
    INSERT INTO subscriptions
    (id, guildId, provider, sourceId, sourceLabel, sourceLogin, types, discordChannelId, mentionRoleIds, enabled, createdBy, createdAt, customTemplate, avatarUrl)
    VALUES
    (@id, @guildId, @provider, @sourceId, @sourceLabel, @sourceLogin, @types, @discordChannelId, @mentionRoleIds, @enabled, @createdBy, @createdAt, @customTemplate, @avatarUrl)
  `,
  ).run(row);
}

// Atomically claim an item. Returns true if THIS call inserted the row (the
// caller now owns sending the alert), false if it was already seen/claimed.
// Because better-sqlite3 is synchronous, the INSERT OR IGNORE can't interleave,
// so claiming before posting makes a duplicate alert impossible even if two
// poll cycles (or two processes) race the same item.
function markSeen(subscriptionId, itemId) {
  const info = db
    .prepare(`INSERT OR IGNORE INTO seen_items (subscriptionId, itemId, seenAt) VALUES (?, ?, ?)`)
    .run(subscriptionId, itemId, Date.now());
  return info.changes > 0;
}

function hasSeen(subscriptionId, itemId) {
  return !!db
    .prepare(`SELECT 1 FROM seen_items WHERE subscriptionId=? AND itemId=?`)
    .get(subscriptionId, itemId);
}

function setLastLiveAlert(subscriptionId, when) {
  db.prepare(`UPDATE subscriptions SET lastLiveAlertAt=? WHERE id=?`).run(when, subscriptionId);
}

function pruneSeenItems() {
  const cutoff = Date.now() - cfg.SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    const info = db.prepare(`DELETE FROM seen_items WHERE seenAt < ?`).run(cutoff);
    if (info.changes) console.log(`[alerts] pruned ${info.changes} old seen_items`);
  } catch (err) {
    console.error('[alerts] seen_items prune failed:', err.message);
  }
}

function getSubsForProvider(provider) {
  return db.prepare(`SELECT * FROM subscriptions WHERE provider=? AND enabled=1`).all(provider);
}

function countGuildSubs(guildId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE guildId=?`).get(guildId).n;
}

// A duplicate is the same source posting to the same Discord channel in the same
// guild. The same channel posting to two DIFFERENT Discord channels is allowed.
function subscriptionExists(guildId, provider, sourceId, discordChannelId) {
  return !!db
    .prepare(
      `SELECT 1 FROM subscriptions WHERE guildId=? AND provider=? AND sourceId=? AND discordChannelId=?`,
    )
    .get(guildId, provider, sourceId, discordChannelId);
}

// ---- Handler-facing helpers (scoped to a guild for safety) ----

function getSubForGuild(id, guildId) {
  return db.prepare(`SELECT * FROM subscriptions WHERE id=? AND guildId=?`).get(id, guildId);
}

function listSubsForGuild(guildId) {
  return db
    .prepare(`SELECT * FROM subscriptions WHERE guildId=? ORDER BY createdAt DESC`)
    .all(guildId);
}

function deleteSubscription(id, guildId) {
  db.prepare(`DELETE FROM subscriptions WHERE id=? AND guildId=?`).run(id, guildId);
  db.prepare(`DELETE FROM seen_items WHERE subscriptionId=?`).run(id);
}

function setCustomTemplate(id, guildId, template) {
  db.prepare(`UPDATE subscriptions SET customTemplate=? WHERE id=? AND guildId=?`).run(
    template,
    id,
    guildId,
  );
}

function clearCustomTemplate(id, guildId) {
  db.prepare(`UPDATE subscriptions SET customTemplate=NULL WHERE id=? AND guildId=?`).run(
    id,
    guildId,
  );
}

function setMentionRoles(id, guildId, rolesJson) {
  db.prepare(`UPDATE subscriptions SET mentionRoleIds=? WHERE id=? AND guildId=?`).run(
    rolesJson,
    id,
    guildId,
  );
}

function getSubsForSource(provider, sourceId) {
  return db
    .prepare(`SELECT * FROM subscriptions WHERE provider=? AND sourceId=? AND enabled=1`)
    .all(provider, sourceId);
}

function getDistinctSourceIds(provider) {
  return db
    .prepare(`SELECT DISTINCT sourceId FROM subscriptions WHERE provider=? AND enabled=1`)
    .all(provider)
    .map(r => r.sourceId);
}

function setAvatarForSource(provider, sourceId, url) {
  db.prepare(`UPDATE subscriptions SET avatarUrl=? WHERE provider=? AND sourceId=?`).run(
    url,
    provider,
    sourceId,
  );
}

module.exports = {
  insertSubscription,
  markSeen,
  hasSeen,
  setLastLiveAlert,
  pruneSeenItems,
  getSubsForProvider,
  getSubsForSource,
  countGuildSubs,
  subscriptionExists,
  getSubForGuild,
  listSubsForGuild,
  deleteSubscription,
  setCustomTemplate,
  clearCustomTemplate,
  setMentionRoles,
  getDistinctSourceIds,
  setAvatarForSource,
};
