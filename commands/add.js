const { SlashCommandBuilder } = require('discord.js');
const whitelist = require('../systems/whitelist.js');
const { isOwner } = require('../systems/permissions.js');
const { replyEphemeral, denyEphemeral } = require('../systems/reply.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('add')
    .setDescription('Owner-only tools')
    // Hide from non-admins in the slash picker (Discord-side). The authoritative
    // gate is the isOwner check in execute(); the bot owner must be a guild admin
    // wherever they run this. '0' = no default permissions => admins only.
    .setDefaultMemberPermissions('0')
    .addSubcommand(sub =>
      sub
        .setName('guild')
        .setDescription('Allow a guild ID to use this bot')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Guild ID to allow').setRequired(true),
        ),
    ),

  async execute(interaction) {
    // Owner check
    if (!isOwner(interaction.user.id)) {
      return denyEphemeral(interaction);
    }

    const guildId = interaction.options.getString('id', true).trim();

    // Very basic validation for a Discord snowflake
    if (!/^\d{10,25}$/.test(guildId)) {
      return replyEphemeral(interaction, '⚠️ That does not look like a valid guild ID.');
    }

    const added = whitelist.add(guildId);
    if (!added) {
      return replyEphemeral(
        interaction,
        `ℹ️ Guild ID \`${guildId}\` is **already** in the allowed list.`,
      );
    }

    return replyEphemeral(
      interaction,
      `✅ Guild ID \`${guildId}\` has been **added** to the allowed list.\n` +
        'ℹ️ New invites to this guild will now be accepted.',
    );
  },
};
