// systems/alerts/alerts.js
// The alerts system's command + interaction surface: slash-command handlers,
// the role-picker component, and init. Database access goes through queries.js;
// the polling engine lives in poller.js. This file owns no SQL and no timers.

const {
  ActionRowBuilder,
  RoleSelectMenuBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const crypto = require('node:crypto');

const cfg = require('../../config/alerts.config.js');
const q = require('./queries.js');
const poller = require('./poller.js');
const yt = require('./providers/youtube.js');
const tw = require('./providers/twitch.js');
const { safeJsonParse, uniq, clampArray, formatTemplate, displayType } = require('./utils.js');

const { isManager } = require('../permissions.js');

function canManageAlerts(member) {
  return isManager(member);
}

function templateHasRequiredPlaceholders(template, required) {
  const t = String(template || '');
  return required.every(ph => t.includes(ph));
}

function getRolePickerRow(subscriptionId) {
  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`alerts_roles:${subscriptionId}`)
      .setPlaceholder('Pick roles to mention (optional)')
      .setMinValues(0)
      .setMaxValues(cfg.MAX_ROLE_MENTIONS),
  );
}

async function initAlertsSystem(client) {
  poller.setClient(client);
  poller.validateAlertsEnv();
  poller.startPollers();
}

// ---------------- Slash command handlers ----------------

async function alertsAdd(interaction) {
  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to configure alerts.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const provider = interaction.options.getString('provider', true);
  const postChannel = interaction.options.getChannel('post_to', true);
  const typesStr = interaction.options.getString('types', true);
  const input = interaction.options.getString('channel', true);

  if (!postChannel.isTextBased()) {
    return interaction.reply({
      content: '\u274C `post_to` must be a text channel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Parse and normalise types
  const rawTypes = typesStr
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // Map user-friendly aliases \u2192 internal values
  const aliasMap = {
    vid: 'vod',
    vod: 'vod',
    short: 'shorts',
    shorts: 'shorts',
    live: 'live',
  };

  // Allowed internal types per provider
  const allowedTypes =
    provider === 'youtube' ? ['vod', 'live', 'shorts'] : provider === 'twitch' ? ['live'] : [];

  // Normalise + validate
  const types = rawTypes.map(t => aliasMap[t]).filter(t => allowedTypes.includes(t));

  if (!types.length) {
    return interaction.reply({
      content:
        `\u274C No valid types.\n` +
        `Allowed: ${provider === 'youtube' ? 'vid, live, short' : 'live'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Per-guild cap: bounds Data API / fetch load and prevents accidental abuse.
  if (q.countGuildSubs(interaction.guildId) >= cfg.MAX_SUBS_PER_GUILD) {
    return interaction.reply({
      content:
        `\u274C This server has reached the alert limit (${cfg.MAX_SUBS_PER_GUILD}). ` +
        'Remove one with `/alerts remove` before adding more.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  if (provider === 'youtube') {
    const youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
    // Resolution can hit the network (Data API / page scrape), so defer first
    // to avoid Discord's 3s interaction timeout on slow lookups.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const resolved = await yt.resolveChannelId(input, youtubeApiKey);
    if (!resolved) {
      return interaction.editReply({
        content:
          '\u274C I couldn\u2019t resolve that YouTube channel.\n' +
          'Try a channel ID (`UC...`), a `/channel/UC...` URL, an `@handle`, ' +
          'or a `youtube.com/@handle` / `/c/` / `/user/` URL.',
      });
    }

    const channelId = resolved.channelId;
    const label = resolved.label || channelId;

    if (q.subscriptionExists(interaction.guildId, provider, channelId, postChannel.id)) {
      return interaction.editReply({
        content: `\u26A0\uFE0F **${label}** is already set up to post in ${postChannel}.`,
      });
    }

    q.insertSubscription({
      id,
      guildId: interaction.guildId,
      provider,
      sourceId: channelId,
      sourceLabel: label,
      sourceLogin: null, // YouTube uses channelId in URLs, not a login slug
      types: JSON.stringify(types),
      discordChannelId: postChannel.id,
      mentionRoleIds: JSON.stringify([]),
      enabled: 1,
      createdBy: interaction.user.id,
      createdAt: now,
      customTemplate: null,
    });

    return interaction.editReply({
      content:
        `\u2705 Added YouTube alerts for **${label}** (\`${channelId}\`) to ${postChannel}.\n` +
        'Now pick roles to mention (optional):',
      components: [getRolePickerRow(id)],
    });
  }

  if (provider === 'twitch') {
    const login = input
      .trim()
      .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
      .replace(/\/.*/, '');

    if (!login) {
      return interaction.reply({
        content: '\u274C Enter a Twitch channel name (login).',
        flags: MessageFlags.Ephemeral,
      });
    }

    const clientId = process.env.TWITCH_CLIENT_ID || '';
    const clientSecret = process.env.TWITCH_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) {
      return interaction.reply({
        content: '\u274C Twitch env vars missing: `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // resolveUser hits the Twitch API; defer first to dodge the 3s timeout.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const u = await tw.resolveUser(login, clientId, clientSecret);
    if (!u) {
      return interaction.editReply({ content: '\u274C I couldn\u2019t find that Twitch user.' });
    }

    if (q.subscriptionExists(interaction.guildId, provider, u.id, postChannel.id)) {
      return interaction.editReply({
        content: `\u26A0\uFE0F **${u.name}** is already set up to post in ${postChannel}.`,
      });
    }

    q.insertSubscription({
      id,
      guildId: interaction.guildId,
      provider,
      sourceId: u.id,
      sourceLabel: u.name, // cased display name, used in {name}
      sourceLogin: u.login, // lowercase slug, used to build the twitch.tv URL
      types: JSON.stringify(['live']),
      discordChannelId: postChannel.id,
      mentionRoleIds: JSON.stringify([]),
      enabled: 1,
      createdBy: interaction.user.id,
      createdAt: now,
      customTemplate: null,
    });

    return interaction.editReply({
      content:
        `\u2705 Added Twitch LIVE alerts for **${u.name}** to ${postChannel}.\n` +
        'Now pick roles to mention (optional):',
      components: [getRolePickerRow(id)],
    });
  }

  return interaction.reply({ content: '\u274C Unknown provider.', flags: MessageFlags.Ephemeral });
}

async function alertsList(interaction) {
  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to view alerts.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const rows = q.listSubsForGuild(interaction.guildId);

  if (!rows.length) {
    return interaction.reply({
      content: '\u2139\uFE0F No alerts configured for this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('\uD83D\uDD14 Alerts configured for this server')
    .setDescription(
      'Use `/alerts remove id:<id>` to delete one, `/alerts roles id:<id>` to change role mentions, ' +
        'or `/alerts template id:<id> template:<text>` to customise the message.',
    )
    .setTimestamp();

  for (const r of rows.slice(0, 20)) {
    const types = safeJsonParse(r.types, []).map(displayType);
    const prettyTypes = types.length ? types.join(' / ') : 'none';
    const roles = safeJsonParse(r.mentionRoleIds, []);

    embed.addFields({
      name: `${r.provider.toUpperCase()} \u2022 ${r.sourceLabel} \u2022 ${r.enabled ? 'enabled' : 'disabled'}`,
      value:
        `**ID:** \`${r.id}\`\n` +
        `**Types:** ${prettyTypes}\n` +
        `**Post to:** <#${r.discordChannelId}>\n` +
        `**Roles:** ${roles.length ? roles.map(id => `<@&${id}>`).join(' ') : '_none_'}`,
    });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function alertsRemove(interaction) {
  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to remove alerts.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = interaction.options.getString('id', true);
  const row = q.getSubForGuild(id, interaction.guildId);
  if (!row) {
    return interaction.reply({
      content: '\u274C That subscription ID was not found in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  q.deleteSubscription(id, interaction.guildId);

  return interaction.reply({
    content: `\u2705 Removed alerts subscription \`${id}\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function alertsRoles(interaction) {
  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to edit roles.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = interaction.options.getString('id', true);
  const row = q.getSubForGuild(id, interaction.guildId);
  if (!row) {
    return interaction.reply({
      content: '\u274C That subscription ID was not found in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `Pick roles to mention for \`${id}\` (optional):`,
    components: [getRolePickerRow(id)],
    flags: MessageFlags.Ephemeral,
  });
}

// -------- Template Set / Reset / Preview --------

async function alertsTemplateSet(interaction) {
  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to edit templates.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = interaction.options.getString('id', true);
  const template = interaction.options.getString('template', true);

  const row = q.getSubForGuild(id, interaction.guildId);

  if (!row) {
    return interaction.reply({
      content: '\u274C That subscription ID was not found in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const trimmed = String(template).trim();

  if (!trimmed.length) {
    return interaction.reply({
      content: '\u274C Template cannot be empty.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Discord message limit is 2000 chars; leave room for role mentions/newlines
  if (trimmed.length > 1900) {
    return interaction.reply({
      content: '\u274C Template is too long (keep it under ~1900 chars).',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Require {url} so alerts always include a clickable link
  if (!trimmed.includes('{url}')) {
    return interaction.reply({
      content:
        '\u274C Template must include `{url}` so people can click the video/stream.\n' +
        'Tip: try `New upload: {title}\\n{url}`\n' +
        'Or reset with `/alerts template-reset id:<id>`',
      flags: MessageFlags.Ephemeral,
    });
  }

  q.setCustomTemplate(id, interaction.guildId, trimmed);

  return interaction.reply({
    content:
      '\u2705 Custom template saved.\n' +
      'Placeholders: `{title}` `{url}` `{channel}` `{name}` `{type}`',
    flags: MessageFlags.Ephemeral,
  });
}

async function alertsTemplateReset(interaction) {
  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to edit templates.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = interaction.options.getString('id', true);
  const row = q.getSubForGuild(id, interaction.guildId);
  if (!row) {
    return interaction.reply({
      content: '\u274C That subscription ID was not found in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  q.clearCustomTemplate(id, interaction.guildId);

  return interaction.reply({
    content: '\u2705 Template reset to default.',
    flags: MessageFlags.Ephemeral,
  });
}

async function alertsTemplatePreview(interaction) {
  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to preview templates.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = interaction.options.getString('id', true);
  const row = q.getSubForGuild(id, interaction.guildId);
  if (!row) {
    return interaction.reply({
      content: '\u274C That subscription ID was not found in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const provider = row.provider;
  const hasCustom = !!(row.customTemplate && String(row.customTemplate).trim().length);

  // Choose the template that will actually be used
  let template = null;

  if (hasCustom) {
    template = row.customTemplate;
  } else if (provider === 'youtube') {
    // pick a reasonable default for preview (vod)
    template = cfg.TEMPLATES.youtube.vod;
  } else if (provider === 'twitch') {
    template = cfg.TEMPLATES.twitch.live;
  } else {
    template = '{url}';
  }

  // Fake values so they can see formatting
  const fake = {
    title: 'Example Title Goes Here',
    url: 'https://example.com/link',
    channel: provider === 'youtube' ? 'Example YouTube Channel' : 'Example Channel',
    name: provider === 'twitch' ? 'ExampleStreamer' : 'ExampleName',
    type: provider === 'youtube' ? 'vod' : 'live',
  };

  // Safety: show what will happen; also ensure {url} exists
  if (!templateHasRequiredPlaceholders(template, ['{url}'])) {
    return interaction.reply({
      content:
        '\u274C This template is missing `{url}` so it would be unsafe to use.\n' +
        'Fix it with `/alerts template ...` or reset with `/alerts template-reset`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const previewText = formatTemplate(template, fake);

  const embed = new EmbedBuilder()
    .setTitle('\uD83D\uDD0E Template preview')
    .setDescription(
      `**Subscription:** \`${row.id}\`\n` +
        `**Provider:** ${provider}\n` +
        `**Using:** ${hasCustom ? 'custom' : 'default'}\n\n` +
        '**Preview:**\n' +
        previewText,
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------------- Component handler (role select) ----------------

async function handleAlertsInteraction(interaction) {
  if (!interaction.isRoleSelectMenu()) return;
  if (!interaction.customId.startsWith('alerts_roles:')) return;

  if (!canManageAlerts(interaction.member)) {
    return interaction.reply({
      content: '\uD83D\uDEAB You need **Manage Server** to change alert roles.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = interaction.customId.split(':')[1];
  const row = q.getSubForGuild(id, interaction.guildId);
  if (!row) {
    return interaction.update({
      content: '\u274C That subscription no longer exists.',
      components: [],
    });
  }

  const roleIds = clampArray(uniq(interaction.values), cfg.MAX_ROLE_MENTIONS);
  q.setMentionRoles(id, interaction.guildId, JSON.stringify(roleIds));

  return interaction.update({
    content: `\u2705 Saved role mentions: ${roleIds.length ? roleIds.map(r => `<@&${r}>`).join(' ') : 'none'}`,
    components: [],
  });
}

module.exports = {
  initAlertsSystem,
  handleAlertsInteraction,
  alertsAdd,
  alertsList,
  alertsRemove,
  alertsRoles,
  alertsTemplateSet,
  alertsTemplateReset,
  alertsTemplatePreview,
};
