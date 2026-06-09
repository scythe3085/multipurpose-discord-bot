// config/tickets.config.js

module.exports = {
  COOLDOWN_MS: 5 * 60 * 1000, // 5 minutes between opening tickets

  // Ticket departments are static; roles are resolved per-guild at runtime.
  departments: {
    contact_owner: {
      key: 'contact_owner',
      label: '👑 Contact Owner',
      panelDescription: 'Important / personal / serious issues.',
      color: 0x9b59b6, // amethyst
      buttonStyle: 1, // Primary
      formQuestions: [
        { id: 'subject', label: 'Short title for your issue', style: 'short', required: true },
        {
          id: 'details',
          label: 'Explain what you need from the owner',
          style: 'paragraph',
          required: true,
        },
      ],
    },
    contact_twitch_mod: {
      key: 'contact_twitch_mod',
      label: '📺 Contact Twitch Mod',
      panelDescription: 'Stream issues, chat reports, bans, etc.',
      color: 0x9146ff, // twitch purple
      buttonStyle: 2, // Secondary
      formQuestions: [
        {
          id: 'subject',
          label: 'What is this about? (ban, report, bug, etc.)',
          style: 'short',
          required: true,
        },
        {
          id: 'details',
          label: 'Describe the Twitch issue and include any links if needed',
          style: 'paragraph',
          required: true,
        },
      ],
    },
    contact_discord_mod: {
      key: 'contact_discord_mod',
      label: '🛡️ Contact Discord Mod',
      panelDescription: 'Rule breaks, support, general help.',
      color: 0x5865f2, // blurple
      buttonStyle: 3, // Success
      formQuestions: [
        {
          id: 'subject',
          label: 'What is this about? (rule break, help, etc.)',
          style: 'short',
          required: true,
        },
        {
          id: 'details',
          label: 'Describe what happened and how staff can help',
          style: 'paragraph',
          required: true,
        },
      ],
    },
  },

  // Status colors for the control-panel container
  STATUS_COLORS: {
    OPEN_UNCLAIMED: 0x57f287, // green
    OPEN_CLAIMED: 0xfee75c, // yellow
    CLOSED: 0xed4245, // red
  },

  PANEL: {
    title: '🎫 Contact Staff',
    intro:
      'Pick the team you need to talk to below. We will create a private thread just for you and staff. ' +
      'You can attach screenshots, logs or any other files inside the thread.',
  },
};
