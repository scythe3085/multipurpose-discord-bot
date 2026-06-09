// systems/store.js
// Shared JSON-backed key/value store. One file per store, loaded once into
// memory at construction and written back atomically (temp file + rename) on
// every mutation so a crash mid-write can never corrupt the store.
//
// Replaces the load()/save()/`let data = {}` boilerplate that guildConfig,
// vcPrefs and ticketState each hand-rolled. Each consumer owns its own shape;
// this layer only owns persistence and the in-memory object.

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./atomicJson.js');

/**
 * Create a JSON store backed by a single file.
 * @param {string} filePath absolute path to the JSON file
 * @param {object} [options]
 * @param {boolean} [options.ensureDir=false] mkdir -p the parent dir before each write
 * @param {string}  [options.label] name used in error logs (defaults to the filename)
 * @returns {{ all, get, set, update, remove, save, reload }}
 */
function createJsonStore(filePath, options = {}) {
  const { ensureDir = false, label = path.basename(filePath) } = options;
  let data = {};

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Only accept a plain object as the root; arrays/primitives reset to {}.
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      data = {};
    }
    return data;
  }

  function save() {
    try {
      if (ensureDir) fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeJsonAtomic(filePath, data);
    } catch (err) {
      console.error(`Failed to save ${label}:`, err);
    }
  }

  // Live reference to the backing object. Callers that mutate it directly must
  // call save() themselves (used by vcPrefs/guildConfig, which keep their own
  // nested-mutation helpers).
  function all() {
    return data;
  }

  function get(key) {
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
  }

  function set(key, value) {
    data[key] = value;
    save();
  }

  // Shallow-merge a patch into the entry at `key`, persisting the result.
  function update(key, patch) {
    data[key] = { ...(data[key] || {}), ...patch };
    save();
    return data[key];
  }

  function remove(key) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      delete data[key];
      save();
    }
  }

  load();
  return { all, get, set, update, remove, save, reload: load };
}

module.exports = { createJsonStore };
