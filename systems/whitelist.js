// systems/whitelist.js
// Single source of truth for the guild allow-list (config/allowed-guilds.json).
//
// Previously index.js, /add and /removeguild each read and wrote this file
// independently. /removeguild used a require()'d snapshot that never saw guilds
// added by /add at runtime, so an add-then-remove in the same process could
// silently resurrect or drop entries. This module owns one in-memory array that
// all three share, writes atomically, and is the only thing that touches the
// file — so every read and write agrees within the single bot process.

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./atomicJson.js');

const FILE_PATH = path.join(__dirname, '..', 'config', 'allowed-guilds.json');

let ids = null; // lazy-loaded; null = not yet read from disk

function load() {
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // De-dupe and normalise to strings; tolerate a non-array file as empty.
    ids = Array.isArray(parsed) ? [...new Set(parsed.map(String))] : [];
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('⚠️ Failed to read allowed-guilds.json:', err);
    }
    ids = [];
  }
  return ids;
}

function ensureLoaded() {
  if (ids === null) load();
  return ids;
}

function persist() {
  try {
    writeJsonAtomic(FILE_PATH, ids);
  } catch (err) {
    console.error('⚠️ Failed to write allowed-guilds.json:', err);
  }
}

/** Snapshot copy of the current allow-list. */
function list() {
  return [...ensureLoaded()];
}

function isAllowed(guildId) {
  return ensureLoaded().includes(String(guildId));
}

/** Add an id. Returns true if added, false if it was already present. */
function add(guildId) {
  const id = String(guildId);
  ensureLoaded();
  if (ids.includes(id)) return false;
  ids.push(id);
  persist();
  return true;
}

/** Remove an id. Returns true if removed, false if it was not present. */
function remove(guildId) {
  const id = String(guildId);
  ensureLoaded();
  const before = ids.length;
  ids = ids.filter(x => x !== id);
  if (ids.length === before) return false;
  persist();
  return true;
}

/** Force a re-read from disk (e.g. if the file was edited out of band). */
function reload() {
  return load();
}

/** Parse a comma/whitespace-separated id list into valid snowflake strings. */
function parseSeedIds(raw) {
  return [
    ...new Set(
      String(raw || '')
        .split(/[,\s]+/)
        .map(s => s.trim())
        .filter(s => /^\d{10,25}$/.test(s)),
    ),
  ];
}

/**
 * Merge ALLOWED_GUILD_IDS from the environment into the allow-list, so the
 * first server can be allowed before the bot ever joins it. Runs once at boot.
 */
function seedFromEnv(env = process.env) {
  const raw = (env.ALLOWED_GUILD_IDS || '').trim();
  const seeds = parseSeedIds(raw);

  // The most likely misconfiguration is a typo'd/misformatted id — warn loudly
  // instead of silently seeding nothing.
  if (raw && !seeds.length) {
    console.warn('⚠️ ALLOWED_GUILD_IDS is set but contains no valid guild ids — check for typos.');
  }

  // add() persists the file once per new id. Fine here: this runs once at boot
  // with a handful of ids at most.
  let added = 0;
  for (const id of seeds) {
    if (add(id)) added++;
  }
  if (added) {
    console.log(`✅ Whitelist: seeded ${added} guild id(s) from ALLOWED_GUILD_IDS.`);
  }
  return added;
}

module.exports = { list, isAllowed, add, remove, reload, parseSeedIds, seedFromEnv };
