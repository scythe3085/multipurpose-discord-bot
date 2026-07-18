// systems/alerts/db.js
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'alerts.sqlite');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(DATA_DIR);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  provider TEXT NOT NULL,          -- youtube | twitch
  sourceId TEXT NOT NULL,          -- youtube channelId | twitch broadcasterId
  sourceLabel TEXT NOT NULL,       -- display name / label
  types TEXT NOT NULL,             -- JSON array: ["vod","live","shorts"]
  discordChannelId TEXT NOT NULL,
  mentionRoleIds TEXT NOT NULL,    -- JSON array: ["roleId1","roleId2"]
  enabled INTEGER NOT NULL DEFAULT 1,
  createdBy TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subs_guild ON subscriptions(guildId);
CREATE INDEX IF NOT EXISTS idx_subs_provider_source ON subscriptions(provider, sourceId);

CREATE TABLE IF NOT EXISTS seen_items (
  subscriptionId TEXT NOT NULL,
  itemId TEXT NOT NULL,
  seenAt INTEGER NOT NULL,
  PRIMARY KEY (subscriptionId, itemId)
);

-- Supports the periodic retention sweep (DELETE ... WHERE seenAt < cutoff).
CREATE INDEX IF NOT EXISTS idx_seen_seenAt ON seen_items(seenAt);
`);

// ---- Migration: add customTemplate column if missing ----
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) db.exec(ddl);
}

ensureColumn(
  'subscriptions',
  'customTemplate',
  `ALTER TABLE subscriptions ADD COLUMN customTemplate TEXT`,
);

// sourceLogin: the lowercase URL slug, stored separately from sourceLabel so
// sourceLabel can hold the cased display name. NULL on pre-migration rows, where
// sourceLabel still holds the login (callers fall back to it for the URL).
ensureColumn(
  'subscriptions',
  'sourceLogin',
  `ALTER TABLE subscriptions ADD COLUMN sourceLogin TEXT`,
);

// lastLiveAlertAt: epoch ms of the last Twitch go-live alert for this sub. Used
// to suppress a re-alert when a brief reconnect mints a new stream id.
ensureColumn(
  'subscriptions',
  'lastLiveAlertAt',
  `ALTER TABLE subscriptions ADD COLUMN lastLiveAlertAt INTEGER`,
);

// avatarUrl: source channel/streamer avatar for the alert embed author icon.
// Filled at subscribe time; Twitch rows are refreshed daily by the poller.
ensureColumn('subscriptions', 'avatarUrl', `ALTER TABLE subscriptions ADD COLUMN avatarUrl TEXT`);

module.exports = db;
