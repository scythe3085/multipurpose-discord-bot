// commands/removeguild.js
const { SlashCommandBuilder } = require('discord.js');
const whitelist = require('../systems/whitelist.js');
const { isOwner } = require('../systems/permissions.js');
const { replyEphemeral, denyEphemeral } = require('../systems/reply.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removeguild')
    .setDescription('Remove a guild ID from the allowed list and auto-leave it (owner only).')
    // Hide from non-admins in the slash picker (Discord-side). The authoritative
    // gate is the isOwner check in execute(); the bot owner must be a guild admin
    // wherever they run this. '0' = no default permissions => admins only.
    .setDefaultMemberPermissions('0')
    .addStringOption(option =>
      option
        .setName('guild_id')
        .setDescription('The guild ID to remove and leave.')
        .setRequired(true),
    ),

  async execute(interaction) {
    // Owner check
    if (!isOwner(interaction.user.id)) {
      return denyEphemeral(interaction);
    }

    const guildId = interaction.options.getString('guild_id', true);

    const removed = whitelist.remove(guildId);
    if (!removed) {
      return replyEphemeral(interaction, `ℹ️ Guild ID \`${guildId}\` is not in the allowed list.`);
    }

    // If the bot is currently in that guild, leave it
    const targetGuild = interaction.client.guilds.cache.get(guildId);
    let leftText = '';

    if (targetGuild) {
      try {
        await targetGuild.leave();
        leftText = ' I have also left that server.';
        console.log(
          `✅ Left guild ${targetGuild.name} (${guildId}) after removal from allowed list.`,
        );
      } catch (err) {
        console.error('Failed to leave removed guild:', err);
        leftText = ' I tried to leave that server but there was an error. Check the logs.';
      }
    }

    return replyEphemeral(
      interaction,
      `✅ Guild ID \`${guildId}\` has been removed from the allowed list.${leftText}`,
    );
  },
};
