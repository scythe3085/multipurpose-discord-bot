// systems/vc/panel.js
// Renders (and edits-in-place) the Components V2 control panel for a temp VC.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ThumbnailBuilder,
  MessageFlags,
} = require('discord.js');
const vcPrefs = require('../vcPrefs.js');
const { tempVoiceChannels } = require('./state.js');
const {
  privacyStatusBadge,
  privacyButtonLabel,
  privacyButtonStyle,
  privacyAccentColor,
} = require('./privacy.js');

async function sendVcPanel(textable, voiceChannel, guild) {
  const meta = tempVoiceChannels.get(voiceChannel.id);
  if (!meta) return;

  const members = [...voiceChannel.members.values()];
  const bannedIds = [...meta.banned];
  const coOwnerIdList = [...meta.coOwners];

  const ownerMember = guild.members.cache.get(meta.ownerId);
  const ownerDisplayName = ownerMember?.displayName || 'Unknown owner';
  const ownerAvatar = ownerMember?.user?.displayAvatarURL?.({ size: 256 }) || null;

  const privacy = meta.privacy || 'public';
  const limit = voiceChannel.userLimit || 0;
  const memberCountText = limit > 0 ? `${members.length}/${limit}` : `${members.length}`;
  const limitText = limit > 0 ? `Limit ${limit}` : 'No limit';

  const { emoji: statusEmoji, word: statusWord } = privacyStatusBadge(privacy);

  const autoSaveOn = vcPrefs.isProfileEnabled(guild.id, meta.ownerId);

  // ---- Header section (owner identity + status badge + avatar accessory) ----
  const headerSection = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${voiceChannel.name}`),
    new TextDisplayBuilder().setContent(
      `${statusEmoji} **${statusWord}**  \u00B7  \uD83D\uDC65 ${memberCountText}  \u00B7  ${limitText}`,
    ),
    new TextDisplayBuilder().setContent(`-# Owner: **${ownerDisplayName}**`),
  );

  if (ownerAvatar) {
    headerSection.setThumbnailAccessory(new ThumbnailBuilder({ media: { url: ownerAvatar } }));
  }

  // ---- Members centerpiece ----
  // Tag the owner and co-owners so identity is clear at a glance.
  const memberLines = members.length
    ? members
        .map(m => {
          const tag =
            m.id === meta.ownerId
              ? ' \uD83D\uDC51'
              : meta.coOwners.has(m.id)
                ? ' \uD83E\uDD1D'
                : '';
          return `\u2022 ${m}${tag}`;
        })
        .join('\n')
    : '_No one is in this VC right now._';

  const membersHeader = new TextDisplayBuilder().setContent(
    `### \uD83D\uDC65 Members  \u00B7  ${members.length}${limit > 0 ? `/${limit}` : ''}`,
  );
  const membersBody = new TextDisplayBuilder().setContent(memberLines);

  // ---- Co-owners + banned (compact, single line each) ----
  const coOwnersText = coOwnerIdList.length
    ? coOwnerIdList.map(id => `<@${id}>`).join(' \u00B7 ')
    : '_none_';
  const bannedText = bannedIds.length ? bannedIds.map(id => `<@${id}>`).join(' \u00B7 ') : '_none_';

  const coOwnersDisplay = new TextDisplayBuilder().setContent(
    `**\uD83E\uDD1D Co-owners**  \u00B7  ${coOwnersText}`,
  );
  const bannedDisplay = new TextDisplayBuilder().setContent(
    `**\uD83D\uDEAB Banned from this VC**  \u00B7  ${bannedText}`,
  );

  // ---- Footer (subtle small text) ----
  const footer = new TextDisplayBuilder().setContent(
    `-# VC auto-deletes when empty  \u00B7  Auto-save: ${autoSaveOn ? 'ON' : 'OFF'}`,
  );

  // ---- Action rows ----
  const privacyButton = new ButtonBuilder()
    .setCustomId(`vc_privacy_cycle:${voiceChannel.id}`)
    .setLabel(privacyButtonLabel(privacy))
    .setStyle(privacyButtonStyle(privacy));

  const buttonsRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_rename:${voiceChannel.id}`)
      .setLabel('\u270F\uFE0F Rename')
      .setStyle(ButtonStyle.Primary),
    privacyButton,
    new ButtonBuilder()
      .setCustomId(`vc_limit:${voiceChannel.id}`)
      .setLabel('\uD83D\uDC65 Limit')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vc_delete:${voiceChannel.id}`)
      .setLabel('\uD83D\uDDD1 Delete')
      .setStyle(ButtonStyle.Danger),
  );

  const buttonsRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_refresh:${voiceChannel.id}`)
      .setLabel('\uD83D\uDD04 Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vc_autosave_toggle:${voiceChannel.id}`)
      .setLabel(`\uD83D\uDCBE Auto-save \u00B7 ${autoSaveOn ? 'ON' : 'OFF'}`)
      .setStyle(autoSaveOn ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  // Manage members dropdown (ban + unban combined)
  const manageMemberOptions = [];
  for (const m of members) {
    if (m.id === meta.ownerId) continue;
    if (meta.banned.has(m.id)) continue;
    manageMemberOptions.push({
      label: `Ban: ${m.displayName}`.slice(0, 100),
      value: `ban:${m.id}`,
      emoji: '\uD83D\uDEAB',
    });
  }
  for (const id of bannedIds) {
    const m = guild.members.cache.get(id);
    manageMemberOptions.push({
      label: `Unban: ${m ? m.displayName : id}`.slice(0, 100),
      value: `unban:${id}`,
      emoji: '\u2705',
    });
  }
  const trimmedManageOptions = manageMemberOptions.slice(0, 25);

  const memberRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`vc_member_manage:${voiceChannel.id}`)
      .setPlaceholder(
        trimmedManageOptions.length
          ? '\uD83D\uDC64 Manage members (ban / unban)'
          : 'No member actions available',
      )
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(!trimmedManageOptions.length)
      .addOptions(
        trimmedManageOptions.length
          ? trimmedManageOptions
          : [{ label: 'No member actions', value: 'none' }],
      ),
  );

  // Manage co-owners dropdown
  const coOwnerManageOptions = [];
  const addableMembers = members.filter(m => m.id !== meta.ownerId && !meta.coOwners.has(m.id));
  coOwnerManageOptions.push(
    ...addableMembers.slice(0, 25).map(m => ({
      label: `Add: ${m.displayName}`.slice(0, 100),
      value: `add:${m.id}`,
      emoji: '\u2795',
    })),
  );
  coOwnerManageOptions.push(
    ...coOwnerIdList.slice(0, 25).map(id => {
      const m = guild.members.cache.get(id);
      const labelName = m ? m.displayName : id;
      return {
        label: `Remove: ${labelName}`.slice(0, 100),
        value: `remove:${id}`,
        emoji: '\u2796',
      };
    }),
  );
  const trimmedCoOwnerOptions = coOwnerManageOptions.slice(0, 25);

  const coOwnerManageRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`vc_coowner_manage:${voiceChannel.id}`)
      .setPlaceholder(
        trimmedCoOwnerOptions.length
          ? '\uD83E\uDD1D Manage co-owners (add / remove)'
          : 'No co-owner actions available',
      )
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(!trimmedCoOwnerOptions.length)
      .addOptions(
        trimmedCoOwnerOptions.length
          ? trimmedCoOwnerOptions
          : [{ label: 'No co-owner actions', value: 'none' }],
      ),
  );

  // ---- Build the V2 container ----
  const container = new ContainerBuilder()
    .setAccentColor(privacyAccentColor(privacy))
    .addSectionComponents(headerSection)
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large))
    .addTextDisplayComponents(membersHeader)
    .addTextDisplayComponents(membersBody)
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(coOwnersDisplay)
    .addTextDisplayComponents(bannedDisplay)
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(footer)
    .addActionRowComponents(buttonsRow1)
    .addActionRowComponents(buttonsRow2)
    .addActionRowComponents(memberRow)
    .addActionRowComponents(coOwnerManageRow);

  const components = [container];
  const flags = MessageFlags.IsComponentsV2;
  // Panel is informational — names render as mentions but never ping.
  const allowedMentions = { parse: [] };

  if (meta.panelMessageId) {
    try {
      const msg = await textable.messages.fetch(meta.panelMessageId);
      if (msg) {
        // V2 messages must keep their flag on edit; if the existing message
        // was an old V1 (embed) panel, this edit will fail and we fall
        // through to send a fresh V2 panel.
        await msg.edit({ components, flags, allowedMentions });
        return;
      }
    } catch (_) {
      // fall through to send a fresh one
    }
  }

  const sent = await textable.send({ components, flags, allowedMentions });
  meta.panelMessageId = sent.id;
  tempVoiceChannels.set(voiceChannel.id, meta);
}

module.exports = { sendVcPanel };
