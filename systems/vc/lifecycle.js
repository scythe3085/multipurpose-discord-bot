// systems/vc/lifecycle.js
// VC lifecycle: restore-on-restart, init, join-to-create, empty cleanup, and the
// top-level voiceStateUpdate router.
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const guildConfig = require('../guildConfig.js');
const vcPrefs = require('../vcPrefs.js');
const staticConfig = require('../../config/vc.config.js');
const { tempVoiceChannels, lastVcCreate, vcOnlyMutes, logVcEvent } = require('./state.js');
const { isEveryoneDenied, applyPrivacy } = require('./privacy.js');
const { sendVcPanel } = require('./panel.js');

/**
 * Restore temp VC tracking for a guild after a restart.
 * Also auto-delete empty temp VCs in the configured VC category.
 */
async function restoreTempVcsForGuild(guild) {
  const vcCfg = guildConfig.getVcConfig(guild.id);
  if (!vcCfg || !vcCfg.vcCategoryId) return;

  const categoryId = vcCfg.vcCategoryId;
  const voiceChannels = guild.channels.cache.filter(
    ch => ch.type === ChannelType.GuildVoice && ch.parentId === categoryId,
  );

  for (const vc of voiceChannels.values()) {
    // If already tracked (e.g. hot reload), skip
    if (tempVoiceChannels.has(vc.id)) continue;

    // Heuristic to find owner: member overwrite with ManageChannels allowed
    let ownerId = null;
    vc.permissionOverwrites.cache.forEach(ow => {
      // type === 1 => member overwrite (discord.js v14)
      if (ow.type === 1 && ow.allow.has(PermissionFlagsBits.ManageChannels)) {
        ownerId = ow.id;
      }
    });

    if (!ownerId) {
      // No clear owner -> treat as not managed by bot
      continue;
    }

    // If no one is in the VC after restart, auto-delete it
    if (!vc.members || vc.members.size === 0) {
      try {
        await logVcEvent(
          guild,
          `\uD83D\uDDD1 Auto-deleting empty temp VC **${vc.name}** after bot restart (owner <@${ownerId}>).`,
        );
      } catch (_) {}
      try {
        await vc.delete('Temporary VC auto-deleted after bot restart because empty');
      } catch (err) {
        console.error('Failed to delete temp VC on restore:', err);
      }
      continue;
    }

    // Infer privacy mode from current overwrites. We can't perfectly distinguish
    // 'friends' from 'private' (both deny @everyone), so use a heuristic: if any
    // user on the owner's friends list currently has Connect: allow, treat it as
    // 'friends'; otherwise 'private'. Operators only need to re-cycle once if
    // the inference is wrong.
    let privacy = 'public';
    if (isEveryoneDenied(vc, guild)) {
      privacy = 'private';
      const friendIds = vcPrefs.getFriends(guild.id, ownerId);
      for (const fid of friendIds) {
        const ow = vc.permissionOverwrites.cache.get(fid);
        if (ow && ow.allow.has(PermissionFlagsBits.Connect)) {
          privacy = 'friends';
          break;
        }
      }
    }

    // Otherwise, restore tracking for this temp VC
    tempVoiceChannels.set(vc.id, {
      ownerId,
      coOwners: new Set(),
      banned: new Set(),
      panelMessageId: null,
      privacy,
    });

    try {
      await logVcEvent(
        guild,
        `Restored temp VC tracking for **${vc.name}** (owner <@${ownerId}>) after bot restart.`,
      );
    } catch (_) {}
  }
}

/**
 * Call this once after the client is ready to restore temp VC state.
 */
async function initVcSystem(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await restoreTempVcsForGuild(guild);
    } catch (err) {
      console.error('Failed to restore temp VCs for guild', guild.id, err);
    }
  }
}

async function handleJoinToCreate(newState) {
  const guild = newState.guild;
  const member = newState.member;

  const vcCfg = guildConfig.getVcConfig(guild.id);
  if (!vcCfg.vcCategoryId) {
    // Warn the user that quick-setup / config isn't done for voice.
    try {
      await member.send(
        '\u26A0\uFE0F The server has not finished setting up temporary VCs yet. ' +
          'An admin should run `/config quick-setup` or `/config set-vc-category`.',
      );
    } catch (_) {}
    return;
  }

  const last = lastVcCreate.get(member.id) ?? 0;
  if (Date.now() - last < staticConfig.CREATION_COOLDOWN_MS) {
    try {
      await member.send('\u23F3 Please wait a bit before creating another voice channel.');
    } catch (_) {}
    return;
  }
  lastVcCreate.set(member.id, Date.now());

  // Pull the user's saved profile (only honoured if profile.enabled === true)
  const profile = vcPrefs.getProfile(guild.id, member.id);
  const useProfile = profile.enabled === true;

  const initialName =
    useProfile && typeof profile.name === 'string' && profile.name.trim().length
      ? profile.name.trim().slice(0, 100)
      : `\uD83D\uDD0A ${member.displayName}'s VC`;

  // 1) Create the VC with NO overwrites so it inherits the category perms.
  // The saved user limit rides along in the same API call instead of costing
  // a follow-up edit.
  const createOptions = {
    name: initialName,
    type: ChannelType.GuildVoice,
    parent: vcCfg.vcCategoryId || null,
  };
  if (
    useProfile &&
    Number.isInteger(profile.userLimit) &&
    profile.userLimit >= 0 &&
    profile.userLimit <= 99
  ) {
    createOptions.userLimit = profile.userLimit;
  }
  const vc = await guild.channels.create(createOptions);

  // Track BEFORE the move so an instant leave still triggers empty-cleanup.
  tempVoiceChannels.set(vc.id, {
    ownerId: member.id,
    coOwners: new Set(),
    banned: new Set(),
    panelMessageId: null,
    privacy: 'public',
  });

  // 2) Move the user in IMMEDIATELY \u2014 this is the only step they can feel.
  // The move needs nothing but the channel to exist; overwrites, privacy and
  // the panel are applied around them once they're already inside.
  try {
    await member.voice.setChannel(vc);
  } catch (err) {
    console.error('Failed to move member into new VC:', err);
  }

  // 3) Bot + owner + blocklist overwrites target DIFFERENT users, so their
  // REST calls are independent \u2014 run them in parallel instead of serially.
  const overwriteWork = [];

  // Ensure the BOT can manage the channel (important if category is restrictive)
  overwriteWork.push(
    (async () => {
      try {
        const me = guild.members.me || (await guild.members.fetchMe());
        await vc.permissionOverwrites.edit(me.id, {
          ManageChannels: true,
          ViewChannel: true,
        });
      } catch (err) {
        console.error('Failed to apply bot overwrite on VC create:', err);
      }
    })(),
  );

  // Owner's special perms (still keeps category inheritance for everyone else)
  overwriteWork.push(
    vc.permissionOverwrites
      .edit(member.id, {
        Connect: true,
        ViewChannel: true,
        ManageChannels: true,
      })
      .catch(err => console.error('Failed to apply owner overwrite on VC create:', err)),
  );

  // Apply any persistent VC blocklist for this owner on this guild
  try {
    const blockedIds = vcPrefs.getBlockedUsers(guild.id, member.id);
    if (Array.isArray(blockedIds) && blockedIds.length) {
      const meta = tempVoiceChannels.get(vc.id);
      if (meta) {
        for (const blockedId of blockedIds) {
          meta.banned.add(blockedId);
          overwriteWork.push(
            vc.permissionOverwrites
              .edit(blockedId, { Connect: false, ViewChannel: true })
              .catch(() => {}),
          );
        }
        tempVoiceChannels.set(vc.id, meta);
      }
    }
  } catch (err) {
    console.error('Failed to apply VC blocklist on creation:', err);
  }

  await Promise.all(overwriteWork);

  // Saved privacy mode goes last \u2014 applyPrivacy edits the same owner and
  // @everyone overwrites the calls above touch, so it must not race them.
  if (useProfile && profile.privacy && profile.privacy !== 'public') {
    try {
      const meta = tempVoiceChannels.get(vc.id);
      if (meta) await applyPrivacy(vc, guild, meta, profile.privacy);
    } catch (err) {
      console.error('Failed to apply saved privacy state on VC create:', err);
    }
  }

  // Control panel + log are best-effort extras \u2014 never hold anything on them.
  if (typeof vc.send === 'function') {
    sendVcPanel(vc, vc, guild).catch(err =>
      console.error('Failed to send VC panel into voice text chat:', err),
    );
  }

  logVcEvent(guild, `\uD83C\uDD95 VC created: **${vc.name}** by **${member.user.tag}**`).catch(
    () => {},
  );
}

async function checkAndCleanupTempVc(oldState) {
  const leftChannel = oldState.channel;
  if (!leftChannel) return;
  if (!tempVoiceChannels.has(leftChannel.id)) return;

  setTimeout(async () => {
    if (!leftChannel || !leftChannel.members) return;

    if (leftChannel.members.size === 0) {
      const meta = tempVoiceChannels.get(leftChannel.id);

      // Always remove from tracking (even if meta is missing)
      tempVoiceChannels.delete(leftChannel.id);

      // Allow owner to immediately create a new VC if they rejoin join-to-create
      if (meta && meta.ownerId) {
        lastVcCreate.delete(meta.ownerId);
      }

      const ownerText = meta && meta.ownerId ? ` (owner <@${meta.ownerId}>)` : '';

      // Delete first; the log is a best-effort extra that must not delay it.
      logVcEvent(
        oldState.guild,
        `\uD83D\uDDD1 VC auto-deleted (empty): **${leftChannel.name}**${ownerText}`,
      ).catch(() => {});
      try {
        await leftChannel.delete('Temporary VC auto-deleted because empty');
      } catch (err) {
        console.error('Failed to delete temp VC:', err);
      }
    }
  }, 2000);
}

async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const vcCfg = guildConfig.getVcConfig(guild.id);
  if (!vcCfg || !vcCfg.joinToCreateVcId) return;

  const joinId = vcCfg.joinToCreateVcId;

  const oldId = oldState.channelId ?? null;
  const newId = newState.channelId ?? null;

  const userId = newState.id || oldState.id;

  // Auto-clear pending VC-only server mute when they join ANY voice channel
  const pending = vcOnlyMutes.get(userId);
  if (pending?.pendingClear && newId) {
    const m =
      newState.member || oldState.member || (await guild.members.fetch(userId).catch(() => null));
    if (m?.voice?.channelId) {
      try {
        await m.voice.setMute(false, 'Auto-clear VC-only mute on next voice join');
        vcOnlyMutes.delete(userId);
      } catch (err) {
        console.error('Failed to auto-clear pending VC-only mute:', err);
        // keep it tracked if it failed
      }
    }
  }

  // User joined or moved into the Join-to-Create VC
  if (newId === joinId && oldId !== joinId) {
    await handleJoinToCreate(newState);
  }

  // User left or moved away from a VC -> maybe clean up a temp VC
  if (oldId && oldId !== newId) {
    await checkAndCleanupTempVc(oldState);

    // If they were VC-muted by the bot in the VC they're leaving:
    const rec = vcOnlyMutes.get(userId);
    if (rec && rec.vcId === oldId) {
      // If they moved to another VC (still connected), unmute now
      if (newId) {
        const m =
          newState.member ||
          oldState.member ||
          (await guild.members.fetch(userId).catch(() => null));
        if (m?.voice?.channelId) {
          try {
            await m.voice.setMute(false, 'VC-only mute cleared on leaving muted VC');
            vcOnlyMutes.delete(userId);
          } catch (err) {
            console.error('Failed to clear VC-only mute on move:', err);
            // If it failed, keep it and mark pending
            vcOnlyMutes.set(userId, { ...rec, pendingClear: true });
          }
        }
      } else {
        // They disconnected entirely -> cannot unmute now, so mark pending
        vcOnlyMutes.set(userId, { ...rec, pendingClear: true });
      }
    }
  }
}

module.exports = { initVcSystem, handleVoiceStateUpdate, restoreTempVcsForGuild };
