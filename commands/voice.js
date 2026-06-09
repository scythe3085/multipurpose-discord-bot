// commands/voice.js
const { SlashCommandBuilder } = require('discord.js');
const { handleVoiceSlash } = require('../systems/vc');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Extra controls for your temp voice channels')

    .addSubcommand(sub =>
      sub
        .setName('block')
        .setDescription('Block a user from any temp VC you own on this server')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to block from your temp VCs').setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('unblock')
        .setDescription('Remove someone from your VC blocklist on this server')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to unblock').setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('mute')
        .setDescription('VC-only mute a user in your current temp VC (does not stick across VCs)')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to VC-mute').setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('unmute')
        .setDescription('Remove VC-only mute from a user in your current temp VC')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to VC-unmute').setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('claim')
        .setDescription('Claim ownership of a temp VC if the original owner has left'),
    )

    .addSubcommand(sub =>
      sub
        .setName('invite')
        .setDescription('Invite a user to join your current temp VC (even if it is locked)')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('User to invite to your current temp VC')
            .setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('friend-add')
        .setDescription('Add someone to your friends list (they bypass Friends-only privacy)')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User to add to your friends list').setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('friend-remove')
        .setDescription('Remove someone from your friends list')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('User to remove from your friends list')
            .setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub.setName('friend-list').setDescription('Show your friends list for this server'),
    ),

  async execute(interaction) {
    await handleVoiceSlash(interaction);
  },
};
