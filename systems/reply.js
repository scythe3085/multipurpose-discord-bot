// systems/reply.js
// Tiny helpers for the bot's most common reply shape: an ephemeral message.
// Saves repeating `{ flags: MessageFlags.Ephemeral }` at every call site and
// gives the "you're not allowed" denial a single default string.

const { MessageFlags } = require('discord.js');

/**
 * Reply ephemerally. Pass a string for a plain content reply, or an object
 * (content/embeds/components/...) to which the ephemeral flag is added.
 */
function replyEphemeral(interaction, payload) {
  const body = typeof payload === 'string' ? { content: payload } : { ...payload };
  body.flags = MessageFlags.Ephemeral;
  return interaction.reply(body);
}

/** Standard ephemeral permission-denied reply. */
function denyEphemeral(interaction, message = '⚠️ You are not allowed to use this command.') {
  return replyEphemeral(interaction, message);
}

module.exports = { replyEphemeral, denyEphemeral };
