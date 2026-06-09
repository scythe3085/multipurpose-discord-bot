// commands/verify.js
const { SlashCommandBuilder } = require('discord.js');
const { handleVerifySlash } = require('../systems/verify.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verification system commands')
    .addSubcommand(sub =>
      sub.setName('panel').setDescription('Post the verify panel in this channel (admin only)'),
    ),
  async execute(interaction) {
    await handleVerifySlash(interaction);
  },
};
