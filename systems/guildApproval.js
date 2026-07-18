// systems/guildApproval.js
// First-run friendly whitelist onboarding. Instead of insta-leaving a
// non-whitelisted guild, DM the bot owner an approval card with Approve/Leave
// buttons (customId prefix wl_, routed by index.js). A startup sweep re-checks
// every current guild, so restarts and missed DMs self-heal. Pending state is
// in-memory only — the sweep is the source of truth.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Injectable for tests (never write the real allow-list from a test).
let deps = {
  whitelist: require('./whitelist.js'),
  isOwner: require('./permissions.js').isOwner,
  getOwnerId: require('./permissions.js').getOwnerId,
};

function _setDepsForTests(overrides) {
  deps = { ...deps, ...overrides };
}

const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000; // auto-leave after 24h unapproved
const pendingTimers = new Map(); // guildId -> Timeout

function parseWlCustomId(customId) {
  const [action, guildId] = String(customId || '').split(':');
  return { action, guildId };
}

function buildApprovalEmbed(guild) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('🛡️ New server wants the bot')
    .setDescription(
      `The bot was added to a server that is not on the allow-list.\n` +
        `Approve to whitelist it, or Leave to reject. If you do nothing, the bot ` +
        `leaves automatically in **24 hours**.`,
    )
    .addFields(
      { name: 'Server', value: `${guild.name}`, inline: true },
      { name: 'Server ID', value: `\`${guild.id}\``, inline: true },
      { name: 'Members', value: `${guild.memberCount ?? '?'}`, inline: true },
    )
    .setTimestamp();
}

function buildApprovalRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wl_approve:${guildId}`)
      .setLabel('✅ Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`wl_deny:${guildId}`)
      .setLabel('🚪 Leave')
      .setStyle(ButtonStyle.Danger),
  );
}

function clearPending(guildId) {
  const t = pendingTimers.get(guildId);
  if (t) clearTimeout(t);
  pendingTimers.delete(guildId);
}

/**
 * Ask the owner (via DM) whether this guild may use the bot. Falls back to the
 * old leave-immediately behaviour when the DM cannot be delivered.
 */
async function requestApproval(client, guild) {
  if (deps.whitelist.isAllowed(guild.id)) return;
  if (pendingTimers.has(guild.id)) return; // already asked, waiting on the owner

  // Claim the slot synchronously BEFORE any await so a concurrent
  // guildCreate + startup sweep can't both DM for the same guild.
  pendingTimers.set(guild.id, null);

  const ownerId = deps.getOwnerId();
  if (!ownerId) {
    console.log(
      `⚠️ Joined unauthorized guild ${guild.name} (${guild.id}) and OWNER_ID is unset — leaving. ` +
        `Tip: set ALLOWED_GUILD_IDS in .env to pre-allow your server.`,
    );
    pendingTimers.delete(guild.id);
    await guild.leave().catch(err => console.error('⚠️ Failed to leave guild:', err));
    return;
  }

  try {
    const owner = await client.users.fetch(ownerId);
    await owner.send({
      embeds: [buildApprovalEmbed(guild)],
      components: [buildApprovalRow(guild.id)],
    });
  } catch (err) {
    console.log(
      `⚠️ Could not DM the owner to approve ${guild.name} (${guild.id}) — leaving. ` +
        `(${err.message}) Tip: set ALLOWED_GUILD_IDS in .env to pre-allow your server.`,
    );
    pendingTimers.delete(guild.id);
    await guild.leave().catch(e => console.error('⚠️ Failed to leave guild:', e));
    return;
  }

  console.log(`📨 Sent whitelist approval DM for ${guild.name} (${guild.id}).`);
  const timer = setTimeout(() => {
    pendingTimers.delete(guild.id);
    const g = client.guilds.cache.get(guild.id);
    if (g && !deps.whitelist.isAllowed(g.id)) {
      console.log(`⏳ Approval window expired for ${g.name} (${g.id}) — leaving.`);
      g.leave().catch(err => console.error('⚠️ Failed to leave expired guild:', err));
    }
  }, PENDING_TIMEOUT_MS);
  // Don't let a pending approval hold the process open on shutdown.
  timer.unref?.();
  pendingTimers.set(guild.id, timer);
}

/** Re-check every current guild — covers joins that happened while offline. */
async function sweepUnapproved(client) {
  for (const guild of client.guilds.cache.values()) {
    if (!deps.whitelist.isAllowed(guild.id)) {
      await requestApproval(client, guild);
    }
  }
}

/** Router target for wl_approve:<id> / wl_deny:<id> DM buttons. */
async function handleWhitelistInteraction(interaction) {
  if (!interaction.isButton()) return;
  const { action, guildId } = parseWlCustomId(interaction.customId);
  if (!guildId) return;

  if (!deps.isOwner(interaction.user.id)) {
    return interaction.reply({ content: '🚫 Only the bot owner can do this.' });
  }

  const guild = interaction.client.guilds.cache.get(guildId);
  const label = guild ? `**${guild.name}**` : `\`${guildId}\``;

  if (action === 'wl_approve') {
    clearPending(guildId);
    deps.whitelist.add(guildId);
    return interaction.update({
      content:
        `✅ Approved ${label} — it is now on the allow-list.` +
        (guild ? '' : '\nℹ️ The bot is not currently in that server; re-invite it.'),
      embeds: [],
      components: [],
    });
  }

  if (action === 'wl_deny') {
    // A stale Deny (old duplicate card) must not yank the bot out of a guild
    // that was since approved — allow-list and membership would desync.
    if (deps.whitelist.isAllowed(guildId)) {
      return interaction.update({
        content: `ℹ️ ${label} is already on the allow-list — use /removeguild to remove and leave it.`,
        embeds: [],
        components: [],
      });
    }

    clearPending(guildId);
    await interaction.update({
      content: `🚪 Denied ${label} — leaving the server.`,
      embeds: [],
      components: [],
    });
    if (guild) {
      await guild.leave().catch(err => console.error('⚠️ Failed to leave denied guild:', err));
    }
    return;
  }
}

module.exports = {
  requestApproval,
  sweepUnapproved,
  handleWhitelistInteraction,
  parseWlCustomId,
  clearPending,
  _setDepsForTests,
};
