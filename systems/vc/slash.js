// systems/vc/slash.js
// /voice slash-command handler (block/unblock/mute/unmute/invite/claim/friends).
const { MessageFlags } = require('discord.js');
const vcPrefs = require('../vcPrefs.js');
const {
  tempVoiceChannels,
  vcOnlyMutes,
  isController,
  findOwnedTempVcForMember,
  logVcEvent,
} = require('./state.js');

async function handleVoiceSlash(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const user = interaction.user;
  const member = interaction.member;

  if (!guild || !member) {
    return interaction.reply({
      content: '\u274C This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'block') {
    const target = interaction.options.getUser('user', true);

    if (target.id === user.id) {
      return interaction.reply({
        content: '\u26A0 You cannot block yourself.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Save to persistent prefs \u2014 that's the source of truth, so confirm now
    // and apply the best-effort overwrite/disconnect to any live VC after.
    vcPrefs.addBlockedUser(guild.id, user.id, target.id);

    await interaction.reply({
      content:
        `\uD83D\uDEAB ${target} has been added to your VC blocklist for this server.\n` +
        'They will be blocked from any temporary VC you own here.',
      flags: MessageFlags.Ephemeral,
    });

    // If this user currently owns a temp VC, update it immediately
    for (const [vcId, meta] of tempVoiceChannels.entries()) {
      if (meta.ownerId !== user.id) continue;

      const channel = guild.channels.cache.get(vcId);
      if (!channel) continue;

      meta.banned.add(target.id);
      tempVoiceChannels.set(vcId, meta);

      channel.permissionOverwrites
        .edit(target.id, { Connect: false, ViewChannel: true })
        .catch(() => {});

      const targetMember = guild.members.cache.get(target.id);
      if (targetMember?.voice?.channelId === vcId) {
        targetMember.voice.disconnect('Blocked from this VC by the owner.').catch(() => {});
      }
    }
    return;
  }

  if (sub === 'unblock') {
    const target = interaction.options.getUser('user', true);
    // Prefs are the source of truth \u2014 confirm now, clear the live overwrite after.
    vcPrefs.removeBlockedUser(guild.id, user.id, target.id);

    await interaction.reply({
      content: `\u2705 ${target} has been removed from your VC blocklist for this server.`,
      flags: MessageFlags.Ephemeral,
    });

    const owned = findOwnedTempVcForMember(member);
    if (owned) {
      const { channel, meta } = owned;
      if (meta.banned.has(target.id)) {
        meta.banned.delete(target.id);
        tempVoiceChannels.set(channel.id, meta);
      }
      channel.permissionOverwrites
        .edit(target.id, { Connect: null, ViewChannel: null })
        .catch(() => {});
    }
    return;
  }
  if (sub === 'mute') {
    const target = interaction.options.getUser('user', true);

    if (!member.voice?.channelId) {
      return interaction.reply({
        content: '\u274C You must be in your temp VC to mute someone.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channelId = member.voice.channelId;
    const meta = tempVoiceChannels.get(channelId);
    if (!meta) {
      return interaction.reply({
        content: '\u274C This VC is not managed by the temp VC system.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      return interaction.reply({
        content: '\u274C Could not find this voice channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!isController(interaction, meta)) {
      return interaction.reply({
        content: '\uD83D\uDEAB You are not allowed to manage this VC.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember?.voice?.channelId || targetMember.voice.channelId !== channelId) {
      return interaction.reply({
        content: '\u26A0 That user must be in your VC to be muted.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await targetMember.voice.setMute(
        true,
        'VC-only mute (clears when leaving this VC or next voice join)',
      );
      vcOnlyMutes.set(targetMember.id, { vcId: channelId, pendingClear: false });
    } catch (err) {
      console.error('VC-only server mute failed:', err);
      return interaction.reply({
        content:
          '\u26A0 Failed to mute them. Check the bot has permission to Mute Members and role position.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: `\uD83D\uDD07 ${target} has been VC-muted in ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'unmute') {
    const target = interaction.options.getUser('user', true);

    // If they're not connected, we can't clear server mute right now.
    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({
        content: '\u274C Could not find that member.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const record = vcOnlyMutes.get(targetMember.id);
    if (!record) {
      return interaction.reply({
        content: '\u26A0 That user is not VC-muted by this bot.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!targetMember.voice?.channelId) {
      // keep it tracked, clear later
      vcOnlyMutes.set(targetMember.id, { ...record, pendingClear: true });
      return interaction.reply({
        content:
          '\u26A0 They are not in voice right now, so I cannot clear a server mute. It will auto-clear next time they join voice.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await targetMember.voice.setMute(false, 'VC-only mute cleared manually');
      vcOnlyMutes.delete(targetMember.id);
    } catch (err) {
      console.error('VC-only server unmute failed:', err);
      return interaction.reply({
        content: '\u26A0 Failed to unmute them. Check bot permissions / role position.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: `\uD83D\uDD0A ${target} has been VC-unmuted.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'invite') {
    const target = interaction.options.getUser('user', true);

    // Must be in a managed temp VC
    if (!member.voice || !member.voice.channelId) {
      return interaction.reply({
        content: '\u274C You must be inside a temporary VC to invite someone to it.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channelId = member.voice.channelId;

    if (!tempVoiceChannels.has(channelId)) {
      return interaction.reply({
        content: '\u274C This VC is not managed by the temp VC system.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = guild.channels.cache.get(channelId);
    const meta = tempVoiceChannels.get(channelId);

    if (!channel) {
      return interaction.reply({
        content: '\u274C Could not find this voice channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Only owner / co-owner / admin can invite
    if (!isController(interaction, meta)) {
      return interaction.reply({
        content: '\uD83D\uDEAB You are not allowed to manage this VC.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Apply explicit allow so they can join even if locked
    try {
      await channel.permissionOverwrites.edit(target.id, {
        Connect: true,
        ViewChannel: true,
      });
    } catch (err) {
      console.error('Failed to invite user to VC:', err);
      return interaction.reply({
        content:
          '\u26A0 Failed to update permissions. Please check the bot\u2019s role is above the user.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: `\u2705 ${target} has been invited and can now join this VC (even if it is locked).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'claim') {
    // Must be in a managed temp VC
    if (!member.voice || !member.voice.channelId) {
      return interaction.reply({
        content: '\u274C You must be inside a temporary VC to claim it.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channelId = member.voice.channelId;
    if (!tempVoiceChannels.has(channelId)) {
      return interaction.reply({
        content: '\u274C This VC is not managed by the temp VC system.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = guild.channels.cache.get(channelId);
    const meta = tempVoiceChannels.get(channelId);

    if (!channel) {
      return interaction.reply({
        content: '\u274C Could not find this voice channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (meta.ownerId === user.id) {
      return interaction.reply({
        content: '\u2139 You already own this VC.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Only allow claim if the original owner is no longer in the channel
    const originalOwnerStillHere = channel.members.has(meta.ownerId);
    if (originalOwnerStillHere) {
      return interaction.reply({
        content: '\u274C The original owner is still in this VC, so you cannot claim it.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Transfer ownership
    const oldOwnerId = meta.ownerId;
    meta.ownerId = user.id;
    tempVoiceChannels.set(channel.id, meta);

    // Update overwrites so the new owner has management perms
    try {
      await channel.permissionOverwrites.edit(user.id, {
        Connect: true,
        ViewChannel: true,
        ManageChannels: true,
      });
    } catch (err) {
      console.error('Failed to adjust permissions on claim:', err);
    }

    await interaction.reply({
      content: `\uD83E\uDD1D You have claimed ownership of ${channel}. You now control this VC and its panel.`,
      flags: MessageFlags.Ephemeral,
    });

    logVcEvent(
      guild,
      `\uD83E\uDD1D VC ownership for **${channel.name}** claimed by **${user.tag}** (was <@${oldOwnerId}>).`,
    ).catch(() => {});
  }

  if (sub === 'friend-add') {
    const target = interaction.options.getUser('user', true);

    if (target.id === user.id) {
      return interaction.reply({
        content: '\u26A0\uFE0F You cannot friend yourself.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (target.bot) {
      return interaction.reply({
        content: '\u26A0\uFE0F You cannot friend a bot.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const added = vcPrefs.addFriend(guild.id, user.id, target.id);
    if (!added) {
      return interaction.reply({
        content: `\u2139\uFE0F ${target} is already on your friends list for this server.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // If this user owns a live temp VC in Friends-only mode, grant Connect now
    let liveApplied = false;
    for (const [vcId, meta] of tempVoiceChannels.entries()) {
      if (meta.ownerId !== user.id) continue;
      if (meta.privacy !== 'friends') continue;
      if (meta.banned.has(target.id)) continue; // block list wins
      if (meta.coOwners.has(target.id)) continue; // already allowed

      const channel = guild.channels.cache.get(vcId);
      if (!channel) continue;

      try {
        await channel.permissionOverwrites.edit(target.id, {
          Connect: true,
          ViewChannel: true,
        });
        liveApplied = true;
      } catch (err) {
        console.error('Failed to apply friend overwrite to live VC:', err);
      }
    }

    return interaction.reply({
      content:
        `\uD83E\uDD1D ${target} added to your friends list for this server.` +
        (liveApplied
          ? '\nThey can now join your current Friends-only VC.'
          : '\nThey will be allowed in any Friends-only VC you own.'),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'friend-remove') {
    const target = interaction.options.getUser('user', true);
    const removed = vcPrefs.removeFriend(guild.id, user.id, target.id);

    if (!removed) {
      return interaction.reply({
        content: `\u274C ${target} is not on your friends list.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Clear their friend allow on any live VC (but not if they're owner / co-owner / banned)
    for (const [vcId, meta] of tempVoiceChannels.entries()) {
      if (meta.ownerId !== user.id) continue;
      if (target.id === meta.ownerId) continue;
      if (meta.coOwners.has(target.id)) continue;
      if (meta.banned.has(target.id)) continue;

      const channel = guild.channels.cache.get(vcId);
      if (!channel) continue;

      try {
        await channel.permissionOverwrites.edit(target.id, {
          Connect: null,
          ViewChannel: null,
        });
      } catch (err) {
        console.error('Failed to clear friend overwrite on live VC:', err);
      }

      // If the VC is currently in Friends-only mode and they were relying on
      // that allow to be in there, disconnect them.
      if (meta.privacy === 'friends' && channel.members.has(target.id)) {
        const tm = guild.members.cache.get(target.id);
        if (tm?.voice?.channelId === vcId) {
          await tm.voice.disconnect("Removed from VC owner's friends list.").catch(() => {});
        }
      }
    }

    return interaction.reply({
      content: `\u2705 ${target} removed from your friends list for this server.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'friend-list') {
    const friends = vcPrefs.getFriends(guild.id, user.id);
    if (!friends.length) {
      return interaction.reply({
        content:
          '\u2139\uFE0F Your friends list for this server is empty.\nUse `/voice friend-add` to add someone \u2014 they will bypass Friends-only privacy on any temp VC you own.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const lines = friends.map(id => `\u2022 <@${id}>`).join('\n');
    return interaction.reply({
      content: `\uD83E\uDD1D **Your VC friends list (${friends.length})**\n${lines}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}

module.exports = { handleVoiceSlash };
