// systems/verify.js
// Verification system using per-guild config for roles/channels.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const staticConfig = require('../config/verify.config.js');
const guildConfig = require('./guildConfig.js');
const { sendLogEmbed } = require('./logEmbed.js');

const VERIFY_LOG_FOOTER = 'Verify system';

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

async function logVerify(guild, opts) {
  const vc = guildConfig.getVerifyConfig(guild.id);
  const logChannelId = vc.logChannelId;
  if (!logChannelId) return;
  const logChannel = guild.channels.cache.get(logChannelId);
  await sendLogEmbed(logChannel, { ...opts, footer: VERIFY_LOG_FOOTER });
}

function userField(user) {
  return { name: 'User', value: `${user} \`${user.tag}\` (\`${user.id}\`)`, inline: false };
}

// ---- Per-guild raid state ----
// A verify storm in one server must not lock verify in any other server.
const raidStateByGuild = new Map();

function getRaidState(guildId) {
  let s = raidStateByGuild.get(guildId);
  if (!s) {
    s = { recentAttempts: [], lockUntil: 0 };
    raidStateByGuild.set(guildId, s);
  }
  return s;
}

function recordVerifyAttempt(guildId, userId) {
  const now = Date.now();
  const { WINDOW_MS, MAX_ATTEMPTS } = staticConfig.SECURITY.RAID_PROTECTION;
  const state = getRaidState(guildId);

  state.recentAttempts.push({ userId, timestamp: now });

  state.recentAttempts = state.recentAttempts.filter(a => now - a.timestamp <= WINDOW_MS);

  if (state.recentAttempts.length > MAX_ATTEMPTS) {
    state.lockUntil = now + staticConfig.SECURITY.RAID_PROTECTION.LOCKOUT_MS;
  }
}

function isRaidLocked(guildId) {
  return getRaidState(guildId).lockUntil > Date.now();
}

function getRaidLockRemaining(guildId) {
  const remaining = getRaidState(guildId).lockUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

// ---- Word challenge ----

function pickChallengeWord() {
  const words = staticConfig.SECURITY.WORD_CHALLENGE.WORDS;
  return words[Math.floor(Math.random() * words.length)];
}

function buildWordChallengeModal(word) {
  const modal = new ModalBuilder()
    .setCustomId(`verify_word_modal:${word}`)
    .setTitle(`Type this word: ${word}`);

  const input = new TextInputBuilder()
    .setCustomId('verify_word_input')
    .setLabel('Type the word shown above to confirm')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(word)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(40);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ---- Shared verify success path ----

async function grantVerifiedRole(interaction, member, guild, vc, { accountAgeMs, viaChallenge }) {
  const roleId = vc.verifiedRoleId;
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  if (!role) {
    return interaction.reply({
      content:
        '⚠️ Verification role is not configured correctly.\n' +
        'An admin needs to run `/config quick-setup` or `/config set-verified-role` before this can be used.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (member.roles.cache.has(role.id)) {
    return interaction.reply({
      content: '✅ You are already verified.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await member.roles.add(role, 'Server verification (passed checks)');
  } catch (err) {
    console.error('Failed to add verify role:', err);
    return interaction.reply({
      content:
        '⚠️ I could not give you the Verified role (role or permission issue). Please contact an admin.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply({
    content: '✅ You have been verified! Welcome to the server 🎉',
    flags: MessageFlags.Ephemeral,
  });

  logVerify(guild, {
    severity: 'success',
    title: viaChallenge ? '✅ Verified (via word challenge)' : '✅ Verified',
    fields: [
      userField(member.user),
      { name: 'Account age', value: formatDuration(accountAgeMs), inline: true },
    ],
  }).catch(() => {});
}

// ---- Slash: /verify panel ----

async function handleVerifySlash(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'panel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '🚫 Only admins can post the verify panel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const panel = staticConfig.PANEL;

    const verifyButton = new ButtonBuilder()
      .setCustomId(panel.buttonCustomId)
      .setLabel(panel.buttonLabel)
      .setStyle(ButtonStyle.Success);
    const buttonRow = new ActionRowBuilder().addComponents(verifyButton);

    const container = new ContainerBuilder()
      .setAccentColor(panel.accentColor)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${panel.title}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(panel.intro))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

    panel.rules.forEach((rule, i) => {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${rule.name}`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(rule.value));
      if (i < panel.rules.length - 1) {
        container.addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
        );
      }
    });

    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${panel.helpText}`))
      .addActionRowComponents(buttonRow);

    await interaction.channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    return interaction.reply({
      content: '✅ Verification panel posted.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ---- Button entry: shared pre-checks ----

// recordAttempt: count this toward raid-protection. The button click records;
// the word-challenge modal re-runs these checks only to re-validate (lock state,
// account age) and must NOT record a second attempt, or every challenged user
// would count twice and halve the effective raid-lock threshold.
async function runPreChecks(interaction, member, guild, { recordAttempt = true } = {}) {
  const vc = guildConfig.getVerifyConfig(guild.id);

  // Block bot accounts
  if (interaction.user.bot) {
    await interaction.reply({
      content:
        '🤖 Bots cannot use the automatic verification system.\n' +
        'If this is a trusted bot, a staff member can manually give it the Verified role.',
      flags: MessageFlags.Ephemeral,
    });
    logVerify(guild, {
      severity: 'warning',
      title: '🤖 Bot account blocked',
      fields: [userField(interaction.user)],
    }).catch(() => {});
    return { halt: true };
  }

  // Raid lock (per-guild)
  if (staticConfig.SECURITY.RAID_PROTECTION.ENABLED && isRaidLocked(guild.id)) {
    const remaining = getRaidLockRemaining(guild.id);
    await interaction.reply({
      content:
        '⛔ Verification is temporarily paused due to unusual activity (possible raid).\n' +
        `Please try again in **${formatDuration(remaining)}**.\n\n` +
        'If you think this is an error, please contact staff.',
      flags: MessageFlags.Ephemeral,
    });
    return { halt: true };
  }

  if (recordAttempt && staticConfig.SECURITY.RAID_PROTECTION.ENABLED) {
    recordVerifyAttempt(guild.id, interaction.user.id);
    if (isRaidLocked(guild.id)) {
      const remaining = getRaidLockRemaining(guild.id);
      await interaction.reply({
        content:
          '⛔ Verification is temporarily paused due to unusual activity (possible raid).\n' +
          `Please try again in **${formatDuration(remaining)}**.\n\n` +
          'If you think this is an error, please contact staff.',
        flags: MessageFlags.Ephemeral,
      });
      logVerify(guild, {
        severity: 'fail',
        title: '🚨 Raid protection triggered',
        fields: [
          { name: 'Lock duration', value: formatDuration(remaining), inline: true },
          {
            name: 'Recent attempts',
            value: `${getRaidState(guild.id).recentAttempts.length}`,
            inline: true,
          },
        ],
      }).catch(() => {});
      return { halt: true };
    }
  }

  // Already verified?
  const roleId = vc.verifiedRoleId;
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  if (role && member.roles.cache.has(role.id)) {
    await interaction.reply({
      content: '✅ You are already verified.',
      flags: MessageFlags.Ephemeral,
    });
    return { halt: true };
  }

  // Account age — hard reject
  const now = Date.now();
  const accountAgeMs = now - interaction.user.createdTimestamp;
  const minAccount = staticConfig.SECURITY.MIN_ACCOUNT_AGE_MS;
  if (accountAgeMs < minAccount) {
    const remaining = minAccount - accountAgeMs;
    await interaction.reply({
      content:
        '⛔ Your Discord account is too new to verify.\n' +
        `You must wait **${formatDuration(remaining)}** (until your account is at least **${formatDuration(minAccount)}** old) and then try again.\n\n` +
        'This helps protect the server from freshly created bot / throwaway accounts.',
      flags: MessageFlags.Ephemeral,
    });

    if (staticConfig.SECURITY.LOG_FAILS) {
      logVerify(guild, {
        severity: 'warning',
        title: '🚫 Verify rejected — account too new',
        fields: [
          userField(interaction.user),
          { name: 'Account age', value: formatDuration(accountAgeMs), inline: true },
          { name: 'Required', value: formatDuration(minAccount), inline: true },
        ],
      }).catch(() => {});
    }
    return { halt: true };
  }

  return { halt: false, accountAgeMs, vc };
}

// ---- Button: /verify panel button click ----

async function handleVerifyButton(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  if (!guild || !member) {
    return interaction.reply({
      content: '❌ Verification can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const pre = await runPreChecks(interaction, member, guild);
  if (pre.halt) return;

  // Suspicion gate: clicked too soon after joining? Show word challenge instead
  // of just rejecting them.
  const minJoinAge = staticConfig.SECURITY.MIN_JOIN_AGE_MS;
  const joinedAt = member.joinedTimestamp || 0;
  const inServerMs = joinedAt > 0 ? Date.now() - joinedAt : Infinity;
  const fastClicker = inServerMs < minJoinAge;

  if (fastClicker && staticConfig.SECURITY.WORD_CHALLENGE.ENABLED) {
    const word = pickChallengeWord();
    await interaction.showModal(buildWordChallengeModal(word));
    if (staticConfig.SECURITY.LOG_FAILS) {
      logVerify(guild, {
        severity: 'info',
        title: '⏱ Word challenge issued',
        fields: [
          userField(interaction.user),
          { name: 'Joined', value: `${formatDuration(inServerMs)} ago`, inline: true },
          { name: 'Threshold', value: formatDuration(minJoinAge), inline: true },
          { name: 'Word', value: `\`${word}\``, inline: true },
        ],
      }).catch(() => {});
    }
    return;
  }

  // Passed all checks — verify directly.
  return grantVerifiedRole(interaction, member, guild, pre.vc, {
    accountAgeMs: pre.accountAgeMs,
    viaChallenge: false,
  });
}

// ---- Modal: word challenge submit ----

async function handleVerifyWordModal(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  if (!guild || !member) {
    return interaction.reply({
      content: '❌ Verification can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // customId format: verify_word_modal:<expectedWord>
  const expected = (interaction.customId.split(':')[1] || '').trim();
  const submitted = (interaction.fields.getTextInputValue('verify_word_input') || '').trim();

  if (!expected || expected.toUpperCase() !== submitted.toUpperCase()) {
    await interaction.reply({
      content:
        '⛔ That did not match the word shown. Please go back to the verify panel and try again.\n' +
        'If you keep having trouble, contact staff.',
      flags: MessageFlags.Ephemeral,
    });
    if (staticConfig.SECURITY.LOG_FAILS) {
      logVerify(guild, {
        severity: 'fail',
        title: '❌ Word challenge failed',
        fields: [
          userField(interaction.user),
          { name: 'Typed', value: `\`${submitted || '_(empty)_'}\``, inline: true },
          { name: 'Expected', value: `\`${expected}\``, inline: true },
        ],
      }).catch(() => {});
    }
    return;
  }

  // Re-run the key checks at submit time (account age etc) since some time has passed
  // and someone could in theory have crafted a delayed flow. Don't record another
  // attempt — the button click already recorded this user.
  const pre = await runPreChecks(interaction, member, guild, { recordAttempt: false });
  if (pre.halt) return;

  return grantVerifiedRole(interaction, member, guild, pre.vc, {
    accountAgeMs: pre.accountAgeMs,
    viaChallenge: true,
  });
}

// ---- Top-level interaction router for verify ----

async function handleVerifyInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === staticConfig.PANEL.buttonCustomId) {
    return handleVerifyButton(interaction);
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('verify_word_modal:')) {
    return handleVerifyWordModal(interaction);
  }
}

module.exports = {
  handleVerifySlash,
  handleVerifyInteraction,
};
