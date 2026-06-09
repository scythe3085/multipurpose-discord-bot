// systems/ticketState.js
// Per-thread ticket state, persisted to data/tickets.json so claim/close/reopen
// keep working across bot restarts. Stores only what we need to re-render the
// merged ticket container: dept, opener, opened-at, the modal answers, and the
// current claim / closed status. Files dropped in the thread itself are NOT
// stored here — Discord keeps them and the close transcript captures URLs.

const path = require('node:path');
const { createJsonStore } = require('./store.js');

const FILE_PATH = path.join(__dirname, '..', 'data', 'tickets.json');

// ensureDir: the data/ folder is gitignored runtime state and may not exist on
// a fresh clone, so create it before the first write.
const store = createJsonStore(FILE_PATH, { ensureDir: true, label: 'tickets.json' });

/**
 * Get the full state object for a thread, or null.
 * Shape:
 *   {
 *     guildId, channelId (parent), departmentKey, openerId, openedAt,
 *     answers: { qid: text },
 *     messageId: snowflake of the merged ticket V2 message we edit,
 *     claimedById: snowflake|null,
 *     closed: boolean,
 *     closedById?: snowflake,
 *     closedReason?: string,
 *     closedAt?: number
 *   }
 */
function get(threadId) {
  if (!threadId) return null;
  const entry = store.get(threadId);
  return entry ? { ...entry } : null;
}

function set(threadId, state) {
  if (!threadId || !state) return;
  store.set(threadId, { ...state });
}

function update(threadId, patch) {
  if (!threadId || !patch) return;
  store.update(threadId, patch);
}

function remove(threadId) {
  if (!threadId) return;
  store.remove(threadId);
}

module.exports = { get, set, update, remove };
