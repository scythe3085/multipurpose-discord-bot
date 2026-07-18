// systems/vc/interactions.js
// Panel interaction handlers: buttons, rename/limit modals, and the
// member/co-owner select menus, plus the component router.
const {
  ChannelType,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const vcPrefs = require('../vcPrefs.js');
const {
  tempVoiceChannels,
  lastVcCreate,
  logVcEvent,
  getVcIdFromCustomId,
  isController,
} = require('./state.js');
const { nextPrivacy, applyPrivacy } = require('./privacy.js');
const { sendVcPanel } = require('./panel.js');

async function handleVcButton(interaction) {
  const action = interaction.customId.split(':')[0];
  const vcId = getVcIdFromCustomId(interaction.customId);
  const guild = interaction.guild;
  if (!guild || !vcId) return;

  const voiceChannel = guild.channels.cache.get(vcId);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    return interaction.reply({
      content: '\u274C That voice channel no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const meta = tempVoiceChannels.get(vcId);
  if (!meta) {
    return interaction.reply({
      content: '\u274C This is not a managed temporary VC.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!isController(interaction, meta)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You are not allowed to control this VC.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'vc_limit') {
    const modal = new ModalBuilder()
      .setCustomId(`vc_limit_modal:${vcId}`)
      .setTitle('Set user limit');

    const limitInput = new TextInputBuilder()
      .setCustomId('vc_limit_value')
      .setLabel('Max users (0\u201399, 0 = unlimited)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(2);

    const row = new ActionRowBuilder().addComponents(limitInput);
    modal.addComponents(row);

    return interaction.showModal(modal);
  }

  if (action === 'vc_rename') {
    const modal = new ModalBuilder()
      .setCustomId(`vc_rename_modal:${vcId}`)
      .setTitle('Rename your VC');

    const nameInput = new TextInputBuilder()
      .setCustomId('vc_new_name')
      .setLabel('New channel name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const row = new ActionRowBuilder().addComponents(nameInput);
    modal.addComponents(row);

    return interaction.showModal(modal);
  }

  if (action === 'vc_privacy_cycle') {
    const current = meta.privacy || 'public';
    const next = nextPrivacy(current);

    // Privacy = several permission-overwrite REST calls; defer so a slow batch
    // can't blow the 3s ack window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await applyPrivacy(voiceChannel, guild, meta, next);
    } catch (err) {
      console.error('Failed to apply privacy mode:', err);
      return interaction.editReply({
        content: '\u26A0\uFE0F Failed to update privacy. Check bot permissions and try again.',
      });
    }

    if (interaction.user.id === meta.ownerId && vcPrefs.isProfileEnabled(guild.id, meta.ownerId)) {
      vcPrefs.patchProfile(guild.id, meta.ownerId, { privacy: next });
    }

    const replyByMode = {
      public: '\uD83D\uDD13 VC is now **Public**. Anyone with category access can join.',
      friends:
        '\uD83E\uDD1D VC is now **Friends-only**. Owner, co-owners, and your friends list can join.',
      private: '\uD83D\uDD12 VC is now **Private**. Only the owner and co-owners can join.',
    };
    await interaction.editReply({ content: replyByMode[next] });

    if (typeof voiceChannel.send === 'function') {
      sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
        console.error('Failed to refresh VC panel:', err),
      );
    }
    return;
  }

  if (action === 'vc_autosave_toggle') {
    if (interaction.user.id !== meta.ownerId) {
      return interaction.reply({
        content: '\uD83D\uDEAB Only the VC owner can toggle their own Auto-save.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const before = vcPrefs.getProfile(guild.id, meta.ownerId);
    const wasOn = before.enabled === true;
    const hadSavedSettings =
      before.name !== undefined || before.userLimit !== undefined || before.privacy !== undefined;
    const next = !wasOn;

    vcPrefs.setProfileEnabled(guild.id, meta.ownerId, next);

    let replyText;
    if (next) {
      if (hadSavedSettings) {
        // Don't overwrite previously saved settings \u2014 they come back as-is.
        replyText =
          '\uD83D\uDCBE Auto-save **ON**. Your previously saved settings will apply when you next create a VC. Future changes here will keep the profile in sync.';
      } else {
        // First-time enable \u2014 snapshot current VC state as the starting profile.
        vcPrefs.patchProfile(guild.id, meta.ownerId, {
          name: voiceChannel.name,
          userLimit: voiceChannel.userLimit || 0,
          privacy: meta.privacy || 'public',
        });
        replyText =
          '\uD83D\uDCBE Auto-save **ON**. Snapshotted your current name, user limit and privacy mode. They will apply when you next create a VC.';
      }
    } else {
      replyText =
        '\uD83D\uDCBE Auto-save **OFF**. Your saved settings are kept; flip it back ON to apply them again.';
    }

    await interaction.reply({ content: replyText, flags: MessageFlags.Ephemeral });

    if (typeof voiceChannel.send === 'function') {
      sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
        console.error('Failed to refresh VC panel:', err),
      );
    }
    return;
  }

  if (action === 'vc_delete') {
    tempVoiceChannels.delete(vcId);
    // Let the owner create again instantly
    if (meta && meta.ownerId) {
      lastVcCreate.delete(meta.ownerId);
    }
    await interaction.reply({
      content: '\uD83D\uDDD1 Deleting this VC...',
      flags: MessageFlags.Ephemeral,
    });
    logVcEvent(
      guild,
      `\uD83D\uDDD1 VC deleted via panel: **${voiceChannel.name}** by **${interaction.user.tag}**`,
    ).catch(() => {});
    try {
      await voiceChannel.delete('VC deleted by controller via panel');
    } catch (err) {
      console.error(err);
    }
    return;
  }

  if (action === 'vc_refresh') {
    await interaction.reply({
      content: '\uD83D\uDD04 VC panel refreshed.',
      flags: MessageFlags.Ephemeral,
    });
    if (typeof voiceChannel.send === 'function') {
      sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
        console.error('Failed to refresh VC panel:', err),
      );
    }
    return;
  }

  // Legacy button from a pre-privacy-cycle panel still hanging around.
  // Refresh the panel so the user gets the new control set.
  if (action === 'vc_lock_toggle') {
    await interaction.reply({
      content:
        '\u2139\uFE0F The lock toggle was replaced by a 3-state Privacy button. Panel refreshed \u2014 try the new button.',
      flags: MessageFlags.Ephemeral,
    });
    if (typeof voiceChannel.send === 'function') {
      sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
        console.error('Failed to refresh VC panel:', err),
      );
    }
    return;
  }
}

async function handleVcModal(interaction) {
  const customId = interaction.customId;

  const isRename = customId.startsWith('vc_rename_modal:');
  const isLimit = customId.startsWith('vc_limit_modal:');

  if (!isRename && !isLimit) return;

  const vcId = getVcIdFromCustomId(customId);
  const guild = interaction.guild;
  if (!guild || !vcId) return;

  const voiceChannel = guild.channels.cache.get(vcId);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    return interaction.reply({
      content: '\u274C That voice channel no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const meta = tempVoiceChannels.get(vcId);
  if (!meta) {
    return interaction.reply({
      content: '\u274C This is not a managed temporary VC.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!isController(interaction, meta)) {
    return interaction.reply({
      content: '\u274C You are not allowed to control this VC.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (isRename) {
    const newName = interaction.fields.getTextInputValue('vc_new_name');
    // Channel renames are rate-limited (2/10min); a queued rename can take
    // minutes. Defer keeps the token alive for up to 15 minutes.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await voiceChannel.setName(newName);

    if (interaction.user.id === meta.ownerId && vcPrefs.isProfileEnabled(guild.id, meta.ownerId)) {
      vcPrefs.patchProfile(guild.id, meta.ownerId, { name: newName });
    }

    await interaction.editReply({ content: `\u2705 VC renamed to **${newName}**.` });

    if (typeof voiceChannel.send === 'function') {
      sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
        console.error('Failed to refresh VC panel:', err),
      );
    }
    return;
  }

  if (isLimit) {
    const valueStr = interaction.fields.getTextInputValue('vc_limit_value').trim();
    const value = parseInt(valueStr, 10);

    if (Number.isNaN(value) || value < 0 || value > 99) {
      return interaction.reply({
        content: '\u26A0 Please enter a whole number from 0 to 99. (0 = no user limit)',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await voiceChannel.setUserLimit(value);

    if (interaction.user.id === meta.ownerId && vcPrefs.isProfileEnabled(guild.id, meta.ownerId)) {
      vcPrefs.patchProfile(guild.id, meta.ownerId, { userLimit: value });
    }

    const nice = value === 0 ? 'no limit' : `${value}`;
    await interaction.editReply({
      content: `\u2705 User limit for this VC is now **${nice}**.`,
    });

    if (typeof voiceChannel.send === 'function') {
      sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
        console.error('Failed to refresh VC panel:', err),
      );
    }
    return;
  }
}

async function handleVcSelect(interaction) {
  const [baseId] = interaction.customId.split(':'); // vc_member_ban, vc_member_unban, vc_coowner_manage
  const vcId = getVcIdFromCustomId(interaction.customId);
  const guild = interaction.guild;
  if (!guild || !vcId) return;

  const voiceChannel = guild.channels.cache.get(vcId);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    return interaction.reply({
      content: '\u274C That voice channel no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const meta = tempVoiceChannels.get(vcId);
  if (!meta) {
    return interaction.reply({
      content: '\u274C This is not a managed temporary VC.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!isController(interaction, meta)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You are not allowed to control this VC.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const rawValue = interaction.values[0];
  if (rawValue === 'none') {
    return interaction.reply({
      content: '\u2139\uFE0F Nothing to manage.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Combined manage-members dropdown: value is "ban:<id>" or "unban:<id>"
  if (baseId === 'vc_member_manage') {
    const [mode, userId] = rawValue.split(':');
    const member = guild.members.cache.get(userId);
    if (!member) {
      return interaction.reply({
        content: '❌ Could not find that member.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (mode === 'ban') {
      meta.banned.add(member.id);
      tempVoiceChannels.set(vcId, meta);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await voiceChannel.permissionOverwrites.edit(member.id, {
        Connect: false,
        ViewChannel: true,
      });
      if (voiceChannel.members.has(member.id)) {
        try {
          await member.voice.disconnect('Banned from this VC only.');
        } catch (_) {}
      }

      await interaction.editReply({
        content: `🚫 ${member} has been **banned from this VC only** (they can still use other channels).`,
      });

      if (typeof voiceChannel.send === 'function') {
        sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
          console.error('Failed to refresh VC panel:', err),
        );
      }
      return;
    }

    if (mode === 'unban') {
      if (!meta.banned.has(member.id)) {
        return interaction.reply({
          content: '❌ That user is not banned from this VC.',
          flags: MessageFlags.Ephemeral,
        });
      }
      meta.banned.delete(member.id);
      tempVoiceChannels.set(vcId, meta);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await voiceChannel.permissionOverwrites.edit(member.id, { Connect: null, ViewChannel: null });

      await interaction.editReply({
        content: `✅ ${member} has been **unbanned** from this VC.`,
      });

      if (typeof voiceChannel.send === 'function') {
        sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
          console.error('Failed to refresh VC panel:', err),
        );
      }
      return;
    }
  }

  // Legacy split dropdowns — kept for stale panels still showing the old layout
  if (baseId === 'vc_member_ban' || baseId === 'vc_member_unban') {
    const member = guild.members.cache.get(rawValue);
    if (!member) {
      return interaction.reply({
        content: '\u274C Could not find that member.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (baseId === 'vc_member_ban') {
      meta.banned.add(member.id);
      tempVoiceChannels.set(vcId, meta);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await voiceChannel.permissionOverwrites.edit(member.id, {
        Connect: false,
        ViewChannel: true,
      });
      if (voiceChannel.members.has(member.id)) {
        try {
          await member.voice.disconnect('Banned from this VC only.');
        } catch (_) {}
      }

      await interaction.editReply({
        content: `\uD83D\uDEAB ${member} has been **banned from this VC only** (they can still use other channels).`,
      });

      if (typeof voiceChannel.send === 'function') {
        sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
          console.error('Failed to refresh VC panel:', err),
        );
      }
      logVcEvent(
        guild,
        `\uD83D\uDEAB ${member.user.tag} banned from VC **${voiceChannel.name}** by **${interaction.user.tag}**`,
      ).catch(() => {});
      return;
    }

    if (baseId === 'vc_member_unban') {
      if (!meta.banned.has(member.id)) {
        return interaction.reply({
          content: '\u274C That user is not banned from this VC.',
          flags: MessageFlags.Ephemeral,
        });
      }
      meta.banned.delete(member.id);
      tempVoiceChannels.set(vcId, meta);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await voiceChannel.permissionOverwrites.edit(member.id, { Connect: null, ViewChannel: null });

      await interaction.editReply({
        content: `\u2705 ${member} has been **unbanned** from this VC.`,
      });

      if (typeof voiceChannel.send === 'function') {
        sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
          console.error('Failed to refresh VC panel:', err),
        );
      }
      logVcEvent(
        guild,
        `\u2705 ${member.user.tag} unbanned from VC **${voiceChannel.name}** by **${interaction.user.tag}**`,
      ).catch(() => {});
      return;
    }
  }

  // Co-owner manage menu: value is "add:<id>" or "remove:<id>"
  if (baseId === 'vc_coowner_manage') {
    const [mode, userId] = rawValue.split(':');
    const member = guild.members.cache.get(userId);
    if (!member) {
      return interaction.reply({
        content: '\u274C Could not find that member.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (mode === 'add') {
      if (member.id === meta.ownerId) {
        return interaction.reply({
          content: '\u2139\uFE0F The owner is already a controller.',
          flags: MessageFlags.Ephemeral,
        });
      }

      meta.coOwners.add(member.id);
      tempVoiceChannels.set(vcId, meta);

      // Make sure new co-owner can always join / see the VC,
      // even if it is currently locked.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await voiceChannel.permissionOverwrites.edit(member.id, {
          Connect: true,
          ViewChannel: true,
        });
      } catch (err) {
        console.error('Failed to apply co-owner permission overrides:', err);
      }

      await interaction.editReply({
        content: `\uD83E\uDD1D ${member} is now a **co-owner** of this VC.`,
      });

      if (typeof voiceChannel.send === 'function') {
        sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
          console.error('Failed to refresh VC panel:', err),
        );
      }
      logVcEvent(
        guild,
        `\uD83E\uDD1D ${member.user.tag} made co-owner of VC **${voiceChannel.name}** by **${interaction.user.tag}**`,
      ).catch(() => {});
      return;
    }

    if (mode === 'remove') {
      if (!meta.coOwners.has(member.id)) {
        return interaction.reply({
          content: '\u274C That user is not a co-owner.',
          flags: MessageFlags.Ephemeral,
        });
      }

      meta.coOwners.delete(member.id);
      tempVoiceChannels.set(vcId, meta);

      // Optional tidy-up: clear explicit overrides so they go back to normal
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await voiceChannel.permissionOverwrites.edit(member.id, {
          Connect: null,
          ViewChannel: null,
        });
      } catch (err) {
        console.error('Failed to clear co-owner overrides on remove:', err);
      }

      await interaction.editReply({
        content: `\u274C ${member} is no longer a co-owner of this VC.`,
      });

      if (typeof voiceChannel.send === 'function') {
        sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
          console.error('Failed to refresh VC panel:', err),
        );
      }
      logVcEvent(
        guild,
        `\u274C ${member.user.tag} removed as co-owner of VC **${voiceChannel.name}** by **${interaction.user.tag}**`,
      ).catch(() => {});
      return;
    }
  }
}

async function handleVcInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith('vc_')) {
    return handleVcButton(interaction);
  }
  if (
    interaction.isModalSubmit() &&
    (interaction.customId.startsWith('vc_rename_modal:') ||
      interaction.customId.startsWith('vc_limit_modal:'))
  ) {
    return handleVcModal(interaction);
  }
  if (
    interaction.isStringSelectMenu() &&
    (interaction.customId.startsWith('vc_member_') ||
      interaction.customId.startsWith('vc_coowner_manage'))
  ) {
    return handleVcSelect(interaction);
  }
}

module.exports = { handleVcInteraction };
