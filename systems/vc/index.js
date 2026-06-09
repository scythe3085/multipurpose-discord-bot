// systems/vc/index.js
// Public facade for the temp-VC system. Keeps the same surface the rest of the
// bot imports: initVcSystem, handleVoiceStateUpdate, handleVcInteraction,
// handleVoiceSlash.
const { initVcSystem, handleVoiceStateUpdate } = require('./lifecycle.js');
const { handleVcInteraction } = require('./interactions.js');
const { handleVoiceSlash } = require('./slash.js');

module.exports = {
  initVcSystem,
  handleVoiceStateUpdate,
  handleVcInteraction,
  handleVoiceSlash,
};
