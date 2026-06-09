// systems/tickets/index.js
// Public facade: the /ticket slash router and the component/modal router. Keeps
// the same surface the rest of the bot imports (handleTicketSlash,
// handleTicketComponentOrModal).
const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { sendTicketPanel } = require('./ui.js');
const {
  handlePanelButton,
  handleTicketModal,
  handleClaim,
  handleAddUserButton,
  handleAddUserSelect,
  handleCloseButton,
  handleCloseModal,
  handleReopen,
} = require('./handlers.js');

async function handleTicketSlash(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'panel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '🚫 Only admins can post the ticket panel.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await sendTicketPanel(interaction.channel);
    return interaction.reply({
      content: '✅ Ticket panel posted.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'close') {
    // Slash equivalent of clicking Close — opens the same confirm modal.
    return handleCloseButton(interaction);
  }
}

// ---- Component / modal router ----

async function handleTicketComponentOrModal(interaction) {
  const id = interaction.customId || '';

  if (interaction.isButton()) {
    if (id.startsWith('ticket_open_panel:')) return handlePanelButton(interaction);
    if (id === 'ticket_close' || id.startsWith('ticket_close:'))
      return handleCloseButton(interaction);
    if (id.startsWith('ticket_claim')) return handleClaim(interaction);
    if (id === 'ticket_addmember_btn' || id.startsWith('ticket_addmember_btn:'))
      return handleAddUserButton(interaction);
    if (id === 'ticket_reopen' || id.startsWith('ticket_reopen:')) return handleReopen(interaction);
  }

  if (interaction.isUserSelectMenu && interaction.isUserSelectMenu()) {
    if (id === 'ticket_addmember_select') return handleAddUserSelect(interaction);
  }

  if (interaction.isModalSubmit()) {
    if (id.startsWith('ticket_modal:')) return handleTicketModal(interaction);
    if (id === 'ticket_close_modal' || id.startsWith('ticket_close_modal:'))
      return handleCloseModal(interaction);
  }
}

module.exports = {
  handleTicketSlash,
  handleTicketComponentOrModal,
};
