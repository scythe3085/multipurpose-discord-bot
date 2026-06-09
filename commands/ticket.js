// commands/ticket.js
const { SlashCommandBuilder } = require('discord.js');
const { handleTicketSlash } = require('../systems/tickets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket system commands')
    .addSubcommand(sub =>
      sub.setName('panel').setDescription('Post the ticket panel in this channel (admin only)'),
    )
    .addSubcommand(sub =>
      sub.setName('close').setDescription('Close this ticket thread and generate transcript'),
    ),
  async execute(interaction) {
    await handleTicketSlash(interaction);
  },
};
