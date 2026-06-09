// commands/config.js
// Admin command to set per-guild IDs for channels / roles so the bot can run anywhere.
// v6 adds /config quick-setup to configure everything in one go and health warnings.
//
// The nine single-field `set-*` subcommands are generated from the SET_FIELDS
// table below — both the slash-command builder and the execute() dispatch read
// from the same source, so adding a new configurable field is a one-line edit.
// `show` and `quick-setup` stay bespoke because they touch every field at once.

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const guildConfig = require('../systems/guildConfig.js');

// ====== SINGLE-FIELD SETTERS ======
// Each entry describes one `/config set-*` subcommand:
//   sub               - subcommand name
//   subDescription    - description shown for the subcommand
//   optionType        - 'channel' | 'role'
//   optionName        - the option's name
//   optionDescription - the option's description
//   key               - the guild-config key this writes
//   requireChannelType (optional) - reject channels that aren't this ChannelType
//   typeError (optional)          - message shown when the type check fails
//   confirm           - (value) => success reply string
const SET_FIELDS = [
  {
    sub: 'set-ticket-log',
    subDescription: 'Set the ticket log channel',
    optionType: 'channel',
    optionName: 'channel',
    optionDescription: 'Log channel for ticket events / transcripts',
    key: 'ticketLogChannelId',
    confirm: v => `✅ Ticket log channel set to ${v}.`,
  },
  {
    sub: 'set-transcript-log',
    subDescription: 'Set the transcript channel (optional, defaults to ticket log)',
    optionType: 'channel',
    optionName: 'channel',
    optionDescription: 'Channel where ticket transcripts are sent',
    key: 'transcriptChannelId',
    confirm: v => `✅ Transcript channel set to ${v}.`,
  },
  {
    sub: 'set-owner-role',
    subDescription: 'Set the ticket "Owner" contact role',
    optionType: 'role',
    optionName: 'role',
    optionDescription: 'Role to ping for "Contact Owner" tickets',
    key: 'ticketOwnerRoleId',
    confirm: v => `✅ Owner contact role set to ${v}.`,
  },
  {
    sub: 'set-twitch-mod-role',
    subDescription: 'Set the ticket "Twitch Mod" contact role',
    optionType: 'role',
    optionName: 'role',
    optionDescription: 'Role to ping for "Contact Twitch Mod" tickets',
    key: 'ticketTwitchModRoleId',
    confirm: v => `✅ Twitch Mod contact role set to ${v}.`,
  },
  {
    sub: 'set-discord-mod-role',
    subDescription: 'Set the ticket "Discord Mod" contact role',
    optionType: 'role',
    optionName: 'role',
    optionDescription: 'Role to ping for "Contact Discord Mod" tickets',
    key: 'ticketDiscordModRoleId',
    confirm: v => `✅ Discord Mod contact role set to ${v}.`,
  },
  {
    sub: 'set-verified-role',
    subDescription: 'Set the role given on successful verification',
    optionType: 'role',
    optionName: 'role',
    optionDescription: 'Role to give when users verify',
    key: 'verifiedRoleId',
    confirm: v => `✅ Verified role set to ${v}.`,
  },
  {
    sub: 'set-verify-log',
    subDescription: 'Set the log channel for verification events',
    optionType: 'channel',
    optionName: 'channel',
    optionDescription: 'Channel where verification logs will be sent',
    key: 'verifyLogChannelId',
    confirm: v => `✅ Verify log channel set to ${v}.`,
  },
  {
    sub: 'set-join-vc',
    subDescription: 'Set the Join-to-Create voice channel',
    optionType: 'channel',
    optionName: 'channel',
    optionDescription: 'Voice channel users join to create their own VC',
    key: 'joinToCreateVcId',
    requireChannelType: ChannelType.GuildVoice,
    typeError: '❌ Please select a **voice channel**.',
    confirm: v => `✅ Join-to-Create VC set to ${v}.`,
  },
  {
    sub: 'set-vc-category',
    subDescription: 'Set the category where temp VCs will be created',
    optionType: 'channel',
    optionName: 'category',
    optionDescription: 'Channel category for temporary VCs',
    key: 'vcCategoryId',
    requireChannelType: ChannelType.GuildCategory,
    typeError: '❌ Please select a **category**.',
    confirm: v => `✅ VC category set to ${v.name}.`,
  },
];

const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configure the bot for this server (admin only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName('show').setDescription('Show the current configuration for this server'),
  )
  .addSubcommand(sub =>
    sub
      .setName('quick-setup')
      .setDescription('Guided one-shot setup for this server')
      // REQUIRED options FIRST
      .addChannelOption(opt =>
        opt
          .setName('ticket_log')
          .setDescription('Log channel for ticket events / transcripts')
          .setRequired(true),
      )
      .addRoleOption(opt =>
        opt
          .setName('verified_role')
          .setDescription('Role to give when users verify')
          .setRequired(true),
      )
      // All the rest are OPTIONAL (must come after the required ones)
      .addChannelOption(opt =>
        opt
          .setName('transcript_log')
          .setDescription(
            'Channel where ticket transcripts are sent (optional, defaults to ticket_log)',
          )
          .setRequired(false),
      )
      .addRoleOption(opt =>
        opt
          .setName('owner_role')
          .setDescription('Role to ping for "Contact Owner" tickets (optional)')
          .setRequired(false),
      )
      .addRoleOption(opt =>
        opt
          .setName('twitch_mod_role')
          .setDescription('Role to ping for "Contact Twitch Mod" tickets (optional)')
          .setRequired(false),
      )
      .addRoleOption(opt =>
        opt
          .setName('discord_mod_role')
          .setDescription('Role to ping for "Contact Discord Mod" tickets (optional)')
          .setRequired(false),
      )
      .addChannelOption(opt =>
        opt
          .setName('verify_log')
          .setDescription(
            'Channel where verification logs will be sent (optional, defaults to ticket_log)',
          )
          .setRequired(false),
      )
      .addChannelOption(opt =>
        opt
          .setName('join_vc')
          .setDescription('Voice channel users join to create their own VC')
          .setRequired(false),
      )
      .addChannelOption(opt =>
        opt
          .setName('vc_category')
          .setDescription('Category where temporary VCs will be created')
          .setRequired(false),
      ),
  );

// Generate the single-field setter subcommands from the table.
for (const field of SET_FIELDS) {
  data.addSubcommand(sub => {
    sub.setName(field.sub).setDescription(field.subDescription);
    const addOption = opt =>
      opt.setName(field.optionName).setDescription(field.optionDescription).setRequired(true);
    if (field.optionType === 'role') {
      sub.addRoleOption(addOption);
    } else {
      sub.addChannelOption(addOption);
    }
    return sub;
  });
}

module.exports = {
  data,
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '🚫 Only administrators can use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'show') {
      const cfg = guildConfig.getGuildConfig(guildId);
      const problems = guildConfig.getConfigStatus(guildId);

      const embed = new EmbedBuilder()
        .setTitle('🛠 Server Configuration')
        .setDescription(
          'Current settings for this server. Use the subcommands of `/config` to change them.',
        )
        .addFields(
          {
            name: 'Tickets',
            value:
              `• Ticket log: ${cfg.ticketLogChannelId ? `<#${cfg.ticketLogChannelId}>` : '_not set_'}\n` +
              `• Transcript channel: ${cfg.transcriptChannelId ? `<#${cfg.transcriptChannelId}>` : '_not set (transcripts disabled)_'}\n` +
              `• Owner role: ${cfg.ticketOwnerRoleId ? `<@&${cfg.ticketOwnerRoleId}>` : '_not set_'}\n` +
              `• Twitch Mod role: ${cfg.ticketTwitchModRoleId ? `<@&${cfg.ticketTwitchModRoleId}>` : '_not set_'}\n` +
              `• Discord Mod role: ${cfg.ticketDiscordModRoleId ? `<@&${cfg.ticketDiscordModRoleId}>` : '_not set_'}`,
          },
          {
            name: 'Verification',
            value:
              `• Verified role: ${cfg.verifiedRoleId ? `<@&${cfg.verifiedRoleId}>` : '_not set_'}\n` +
              `• Verify log: ${cfg.verifyLogChannelId ? `<#${cfg.verifyLogChannelId}>` : '_not set (uses ticket log if set)_'}`,
          },
          {
            name: 'Voice',
            value:
              `• Join-to-Create VC: ${cfg.joinToCreateVcId ? `<#${cfg.joinToCreateVcId}>` : '_not set_'}\n` +
              `• VC category: ${cfg.vcCategoryId ? `<#${cfg.vcCategoryId}>` : '_not set_'}`,
          },
        )
        .setTimestamp();

      if (problems.length) {
        embed.addFields({
          name: '⚠️ Setup Warnings',
          value: problems.map(p => `• ${p}`).join('\n'),
        });
      } else {
        embed.addFields({
          name: '✅ Setup Status',
          value: 'Everything essential looks configured!',
        });
      }

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'quick-setup') {
      const ticketLog = interaction.options.getChannel('ticket_log');
      const transcriptLog = interaction.options.getChannel('transcript_log');
      const ownerRole = interaction.options.getRole('owner_role');
      const twitchModRole = interaction.options.getRole('twitch_mod_role');
      const discordModRole = interaction.options.getRole('discord_mod_role');
      const verifiedRole = interaction.options.getRole('verified_role');
      const verifyLog = interaction.options.getChannel('verify_log');
      const joinVc = interaction.options.getChannel('join_vc');
      const vcCategory = interaction.options.getChannel('vc_category');

      if (joinVc && joinVc.type !== ChannelType.GuildVoice) {
        return interaction.reply({
          content: '❌ `join_vc` must be a **voice channel**.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (vcCategory && vcCategory.type !== ChannelType.GuildCategory) {
        return interaction.reply({
          content: '❌ `vc_category` must be a **category**.',
          flags: MessageFlags.Ephemeral,
        });
      }

      guildConfig.updateGuildConfig(guildId, {
        ticketLogChannelId: ticketLog.id,
        transcriptChannelId: transcriptLog ? transcriptLog.id : null,
        ticketOwnerRoleId: ownerRole ? ownerRole.id : null,
        ticketTwitchModRoleId: twitchModRole ? twitchModRole.id : null,
        ticketDiscordModRoleId: discordModRole ? discordModRole.id : null,
        verifyLogChannelId: verifyLog ? verifyLog.id : null,
        verifiedRoleId: verifiedRole.id,
        joinToCreateVcId: joinVc ? joinVc.id : null,
        vcCategoryId: vcCategory ? vcCategory.id : null,
      });

      const problems = guildConfig.getConfigStatus(guildId);

      const embed = new EmbedBuilder()
        .setTitle('✅ Quick Setup Complete')
        .setDescription('I saved the configuration for this server. Here is a summary:')
        .addFields(
          {
            name: 'Tickets',
            value:
              `• Ticket log: ${ticketLog}\n` +
              `• Transcript channel: ${transcriptLog || '_not set (transcripts disabled)_'}\n` +
              `• Owner role: ${ownerRole || '_not set_'}\n` +
              `• Twitch Mod role: ${twitchModRole || '_not set_'}\n` +
              `• Discord Mod role: ${discordModRole || '_not set_'}`,
          },
          {
            name: 'Verification',
            value:
              `• Verified role: ${verifiedRole}\n` +
              `• Verify log: ${verifyLog || '_not set (uses ticket log if set)_'}`,
          },
          {
            name: 'Voice',
            value:
              `• Join-to-Create VC: ${joinVc || '_not set_'}\n` +
              `• VC category: ${vcCategory || '_not set_'}`,
          },
        )
        .setTimestamp();

      if (problems.length) {
        embed.addFields({
          name: '⚠️ Setup Warnings',
          value: problems.map(p => `• ${p}`).join('\n'),
        });
      } else {
        embed.addFields({
          name: '✅ Setup Status',
          value: 'Everything essential looks configured!',
        });
      }

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // -------- Single-field setters (table-driven) --------
    const field = SET_FIELDS.find(f => f.sub === sub);
    if (field) {
      const value =
        field.optionType === 'role'
          ? interaction.options.getRole(field.optionName)
          : interaction.options.getChannel(field.optionName);

      if (field.requireChannelType && value.type !== field.requireChannelType) {
        return interaction.reply({
          content: field.typeError,
          flags: MessageFlags.Ephemeral,
        });
      }

      guildConfig.updateGuildConfig(guildId, { [field.key]: value.id });
      return interaction.reply({
        content: field.confirm(value),
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
