// systems/atomicJson.js
// Crash-safe JSON write: serialize to a temp file then atomically rename it over
// the target. A process kill mid-write can therefore never truncate/corrupt the
// whole store — the target is only ever replaced by a fully-written file.
// (renameSync is atomic on the same filesystem.)

const fs = require('node:fs');

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

module.exports = { writeJsonAtomic };
