// systems/tickets/handlers.js
// Interaction handlers for the ticket lifecycle: open (panel button + modal),
// claim/release, add user, close (button + confirm modal), reopen, and the
// transcript builder used on close.
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  UserSelectMenuBuilder,
} = require('discord.js');
const config = require('../../config/tickets.config.js');
const guildConfig = require('../guildConfig.js');
const ticketState = require('../ticketState.js');
const {
  lastTicketOpen,
  isOnCooldown,
  markCooldown,
  logTicket,
  isTicketStaff,
  getDepartmentRolesForGuild,
  isDeptStaff,
} = require('./helpers.js');
const {
  buildOpenTicketModal,
  buildCloseConfirmModal,
  buildOpenControlPanel,
  renderedAnswer,
  sendChunkedText,
  buildTicketContainer,
  buildClosedControlPanel,
} = require('./ui.js');

async function handlePanelButton(interaction) {
  const [, departmentKey] = interaction.customId.split(':');
  const dep = config.departments[departmentKey];
  if (!dep) {
    return interaction.reply({ content: '❌ Unknown ticket type.', flags: MessageFlags.Ephemeral });
  }

  // Staff bypass cooldown — they may need to test, or open a follow-up quickly
  if (!isTicketStaff(interaction.member) && isOnCooldown(interaction.user.id)) {
    const last = lastTicketOpen.get(interaction.user.id) ?? 0;
    const remaining = Math.ceil((config.COOLDOWN_MS - (Date.now() - last)) / 1000);
    return interaction.reply({
      content: `⏳ You opened a ticket recently.\nPlease wait **${remaining}s** before opening another.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildOpenTicketModal(departmentKey));
}

async function handleTicketModal(interaction) {
  const [, departmentKey] = interaction.customId.split(':');
  const dep = config.departments[departmentKey];
  if (!dep) return;

  const guild = interaction.guild;
  const parentChannel = interaction.channel;

  if (!guild || !parentChannel || !parentChannel.isTextBased()) {
    return interaction.reply({
      content: '❌ Tickets can only be used in a server text channel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Modal submits give us 3s to ack the token. Creating the thread, sending
  // three V2 messages, and re-uploading any attached files all together
  // routinely blow that window — defer immediately and editReply at the end.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isTicketStaff(interaction.member)) markCooldown(interaction.user.id);

  const answers = {};
  for (const q of dep.formQuestions) {
    answers[q.id] = interaction.fields.getTextInputValue(q.id);
  }

  // Files attached in the modal (added Oct 2025 via FileUploadBuilder)
  let uploadedFiles = [];
  try {
    const collection = interaction.fields.getUploadedFiles?.('ticket_files');
    if (collection) uploadedFiles = [...collection.values()];
  } catch (err) {
    // If discord.js on this bot is older than the FileUpload feature, just skip silently.
    console.error('Could not read uploaded files from ticket modal:', err);
  }

  const username = interaction.user.username.replace(/[^a-zA-Z0-9]/g, '');
  const threadName = `ticket-${username}`.slice(0, 90);

  const thread = await parentChannel.threads.create({
    name: threadName,
    type: ChannelType.PrivateThread,
    autoArchiveDuration: 1440, // 24h
    reason: `Ticket for ${interaction.user.tag} (${interaction.user.id})`,
  });

  const roleIds = getDepartmentRolesForGuild(guild.id, departmentKey);
  const validRoleIds = roleIds.filter(id => guild.roles.cache.has(id));
  const staffPing = validRoleIds.length ? validRoleIds.map(id => `<@&${id}>`).join(' ') : '@here';
  const pingLine = `${staffPing} · new ticket from ${interaction.user}`;

  // One merged V2 container with the Q/A, status, and action buttons all
  // together. Sent once and edited in-place on claim / close / reopen.
  const initialState = {
    guildId: guild.id,
    parentChannelId: parentChannel.id,
    departmentKey,
    openerId: interaction.user.id,
    openedAt: Date.now(),
    answers,
    claimedById: null,
    closed: false,
  };

  const container = buildTicketContainer(initialState, { pingLine });
  const sentMessage = await thread.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { roles: validRoleIds, users: [interaction.user.id] },
  });

  // Persist so claim/close/reopen across restarts can re-render this exact
  // ticket from disk. messageId is the V2 message we will edit later.
  ticketState.set(thread.id, { ...initialState, messageId: sentMessage.id });

  // Ack the user NOW — overflow text, file re-uploads and the log embed are
  // best-effort extras that shouldn't hold the confirmation hostage.
  await interaction.editReply({
    content: `✅ Your ticket has been created: ${thread}`,
  });

  // If any answer had to be truncated to fit the V2 budget, post the full
  // text as plain follow-up messages so nothing is lost. Most tickets won't
  // hit this path — only paragraph dumps over ~1500 chars per field.
  const overflowSections = [];
  for (const q of dep.formQuestions) {
    if (renderedAnswer(answers[q.id]).truncated) {
      overflowSections.push(`**${q.label} (full):**\n${(answers[q.id] || '').trim()}`);
    }
  }
  if (overflowSections.length) {
    try {
      await sendChunkedText(thread, overflowSections.join('\n\n'));
    } catch (err) {
      console.error('Failed to send overflow text into ticket thread:', err);
    }
  }

  // Forward any modal-attached files into the thread (own message so it sits
  // alongside the info card; transcript captures them on close).
  if (uploadedFiles.length) {
    const files = uploadedFiles.map(att => new AttachmentBuilder(att.url, { name: att.name }));
    let reuploaded = false;
    try {
      await thread.send({
        content: `📎 Attached by ${interaction.user} (${uploadedFiles.length} file${uploadedFiles.length === 1 ? '' : 's'})`,
        files,
        allowedMentions: { parse: [] },
      });
      reuploaded = true;
    } catch (err) {
      console.error(
        'Failed to re-upload modal files into ticket thread, falling back to URLs:',
        err,
      );
    }
    if (!reuploaded) {
      const links = uploadedFiles
        .map(
          att =>
            `• [${att.name || 'file'}](${att.url})${att.size ? ` · ${(att.size / 1024).toFixed(1)} KB` : ''}`,
        )
        .join('\n');
      await thread.send({
        content: `📎 Files attached by ${interaction.user} (could not re-upload, links may expire):\n${links}`,
        allowedMentions: { parse: [] },
      });
    }
  }

  logTicket(guild, {
    severity: 'info',
    title: `🆕 ${dep.label}`,
    description:
      `${interaction.user} opened ${thread}` +
      (uploadedFiles.length ? ` · 📎 ${uploadedFiles.length}` : ''),
  }).catch(() => {});
}

// ---- Claim / unclaim ----

async function handleClaim(interaction) {
  if (!isTicketStaff(interaction.member)) {
    return interaction.reply({
      content: '🚫 Only staff can claim tickets.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // customId formats:
  //   new (with state):      ticket_claim:<dept>            (unclaimed)
  //                          ticket_claim:<dept>:<claimerId>(claimed)
  //   legacy (pre-merge):    ticket_claim                    (unclaimed)
  //                          ticket_claim:<claimerId>        (claimed)
  // We can tell them apart by whether part[1] is a known department key.
  const parts = interaction.customId.split(':');
  const maybeDept = parts[1];
  const isNewFormat = !!maybeDept && !!config.departments[maybeDept];

  const state = ticketState.get(interaction.channel?.id);

  // ----- New format: state-backed merged container -----
  if (isNewFormat && state) {
    if (state.closed) {
      return interaction.reply({
        content: 'ℹ️ This ticket is closed. Reopen it first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const isCurrentlyClaimed = !!state.claimedById;
    if (isCurrentlyClaimed && state.claimedById !== interaction.user.id) {
      return interaction.reply({
        content: `ℹ️ This ticket is already claimed by <@${state.claimedById}>. Ask them to release it first if you need to take over.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }

    if (isCurrentlyClaimed) {
      // Release — silent in the log channel (low signal)
      ticketState.update(interaction.channel.id, { claimedById: null });
      const updated = ticketState.get(interaction.channel.id);
      await interaction.update({
        components: [buildTicketContainer(updated)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Claim
    ticketState.update(interaction.channel.id, { claimedById: interaction.user.id });
    const updated = ticketState.get(interaction.channel.id);
    await interaction.update({
      components: [buildTicketContainer(updated)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    logTicket(interaction.guild, {
      severity: 'success',
      title: '👋 Ticket claimed',
      description: `${interaction.user} claimed ${interaction.channel}`,
    }).catch(() => {});
    return;
  }

  // ----- Legacy format fallback (tickets created before disk-backed state) -----
  // parts[1] in legacy unclaimed is undefined; in legacy claimed is the claimerId snowflake.
  const legacyClaimerId = !isNewFormat ? parts[1] : null;
  const legacyClaimed = !!legacyClaimerId;

  if (legacyClaimed && legacyClaimerId !== interaction.user.id) {
    return interaction.reply({
      content: `ℹ️ This ticket is already claimed by <@${legacyClaimerId}>. Ask them to release it first if you need to take over.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  if (legacyClaimed) {
    const reopened = buildOpenControlPanel(null);
    await interaction.update({ components: [reopened], flags: MessageFlags.IsComponentsV2 });
    return; // released — no log
  }

  const claimed = buildOpenControlPanel(interaction.user.id);
  await interaction.update({ components: [claimed], flags: MessageFlags.IsComponentsV2 });
  logTicket(interaction.guild, {
    severity: 'success',
    title: '👋 Ticket claimed',
    description: `${interaction.user} claimed ${interaction.channel}`,
  }).catch(() => {});
}

// ---- Add user (button -> ephemeral user select) ----

async function handleAddUserButton(interaction) {
  if (!isTicketStaff(interaction.member)) {
    return interaction.reply({
      content: '🚫 Only staff can add users to a ticket.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const select = new UserSelectMenuBuilder()
    .setCustomId('ticket_addmember_select')
    .setPlaceholder('Pick a member to add to this ticket')
    .setMinValues(1)
    .setMaxValues(1);

  return interaction.reply({
    content: 'Pick someone to add to this private thread.',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleAddUserSelect(interaction) {
  if (!isTicketStaff(interaction.member)) {
    return interaction.reply({
      content: '🚫 Only staff can add users to a ticket.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const userId = interaction.values?.[0];
  if (!userId) {
    return interaction.update({ content: '❌ No user picked.', components: [] });
  }

  const channel = interaction.channel;
  if (!channel?.isThread || !channel.isThread()) {
    return interaction.update({
      content: '❌ This is not a ticket thread anymore.',
      components: [],
    });
  }

  const target = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!target) {
    return interaction.update({ content: '❌ Could not find that member.', components: [] });
  }
  if (target.user.bot) {
    return interaction.update({
      content: '⚠️ Cannot add a bot to a ticket through this dialog.',
      components: [],
    });
  }

  try {
    // No `reason` arg — discord.js deprecated it because the API doesn't parse it.
    await channel.members.add(target.id);
  } catch (err) {
    console.error('Failed to add user to ticket thread:', err);
    return interaction.update({
      content: '⚠️ Failed to add that user. Check that the bot can manage threads.',
      components: [],
    });
  }

  await interaction.update({
    content: `✅ Added ${target} to this ticket.`,
    components: [],
  });

  logTicket(interaction.guild, {
    severity: 'info',
    title: '➕ User added to ticket',
    description: `${interaction.user} added ${target.user} to ${channel}`,
  }).catch(() => {});
}

// ---- Close (confirm modal -> close logic) ----

async function handleCloseButton(interaction) {
  if (!isTicketStaff(interaction.member)) {
    return interaction.reply({
      content: '🚫 You do not have permission to close this ticket.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // If we already know this ticket is closed (stale button click on an
  // already-closed message), don't pop the modal — that would just lead to
  // the modal submit failing on an archived thread.
  const state = ticketState.get(interaction.channel?.id);
  if (state?.closed) {
    return interaction.reply({
      content: 'ℹ️ This ticket is already closed. Use the **Reopen** button if you need it back.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildCloseConfirmModal());
}

async function buildTranscript(thread) {
  const messages = [];
  let lastId = null;

  while (true) {
    const fetched = await thread.messages.fetch({ limit: 100, before: lastId || undefined });
    if (fetched.size === 0) break;
    fetched.forEach(m => messages.push(m));
    lastId = fetched.last().id;
    if (fetched.size < 100) break;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = [];
  for (const m of messages) {
    const time = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author.tag} (${m.author.id})`;
    const editedTag = m.editedTimestamp ? ' [edited]' : '';
    const head = `[${time}] ${author}${editedTag}:`;
    lines.push(head);

    if (m.content && m.content.trim()) {
      for (const line of m.content.split('\n')) lines.push(`  ${line}`);
    }

    for (const att of m.attachments.values()) {
      lines.push(`  📎 ${att.name || 'file'} (${att.size ?? '?'} bytes) — ${att.url}`);
    }

    for (const emb of m.embeds || []) {
      const t = emb.title ? emb.title : '';
      const d = emb.description ? emb.description : '';
      if (t || d) lines.push(`  🔗 Embed: ${t ? `"${t}"` : ''}${t && d ? ' — ' : ''}${d}`);
      for (const f of emb.fields || []) {
        lines.push(`     • ${f.name}: ${f.value}`);
      }
    }

    if (!m.content && m.attachments.size === 0 && (!m.embeds || m.embeds.length === 0)) {
      lines.push('  _(no text content)_');
    }
    lines.push('');
  }

  return lines.join('\n') || 'No messages.';
}

async function handleCloseModal(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;

  if (!channel?.isThread || !channel.isThread()) {
    return interaction.reply({
      content: '❌ Close confirm came from a non-thread channel.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!isTicketStaff(interaction.member)) {
    return interaction.reply({
      content: '🚫 You do not have permission to close this ticket.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const reason = (interaction.fields.getTextInputValue('ticket_close_reason') || '').trim();

  // If the thread auto-archived between showModal and the submit, deferReply
  // (which posts a new message in the channel) will 403 with "Thread is
  // archived". Unarchive first; we re-archive at the end of the close flow
  // anyway, so the net state is the same.
  if (channel.archived) {
    try {
      await channel.setArchived(false, 'Reopening to process close');
    } catch (err) {
      console.error('Failed to unarchive archived thread before close:', err);
    }
  }

  // Fetching messages + transcript build can take seconds — defer.
  await interaction.deferReply();

  // Build transcript
  let transcript;
  try {
    transcript = await buildTranscript(channel);
  } catch (err) {
    console.error('Failed to build transcript:', err);
    transcript = '(failed to fetch messages — see thread directly)';
  }
  const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), {
    name: `transcript-${channel.name}.txt`,
  });

  // Update in-thread UI and deliver the transcript IN PARALLEL — they're
  // independent REST calls — then ack. The log embed is fire-and-forget.
  const state = ticketState.get(channel.id);

  const uiUpdate = (async () => {
    if (state && state.messageId) {
      // New format: edit the merged container in-place (no extra message)
      const updatedState = {
        ...state,
        closed: true,
        closedById: interaction.user.id,
        closedReason: reason || undefined,
        closedAt: Date.now(),
      };
      ticketState.set(channel.id, updatedState);
      try {
        const msg = await channel.messages.fetch(state.messageId);
        await msg.edit({
          components: [buildTicketContainer(updatedState)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.error(
          'Failed to edit ticket message on close, falling back to a separate closed panel:',
          err,
        );
        const closedPanel = buildClosedControlPanel(interaction.user, reason);
        await channel.send({
          components: [closedPanel],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
        });
      }
    } else {
      // Legacy: send a separate closed-state panel
      const closedPanel = buildClosedControlPanel(interaction.user, reason);
      await channel.send({
        components: [closedPanel],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
    }
  })();

  const transcriptDelivery = (async () => {
    const transcriptChannelId = guildConfig.getTicketConfig(guild.id).transcriptChannelId;
    const transcriptChannel = transcriptChannelId
      ? guild.channels.cache.get(transcriptChannelId)
      : null;
    if (transcriptChannel?.isTextBased()) {
      try {
        await transcriptChannel.send({
          content:
            `📄 Transcript for \`${channel.name}\` · closed by ${interaction.user}` +
            (reason ? `\n**Reason:** ${reason.slice(0, 1000)}` : ''),
          files: [attachment],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.error('Failed to deliver transcript:', err);
      }
    }
  })();

  await Promise.all([uiUpdate, transcriptDelivery]);

  await interaction.editReply({
    content: '🔒 Ticket closed and transcript saved.',
  });

  logTicket(guild, {
    severity: 'success',
    title: '✅ Ticket closed',
    description:
      `${interaction.user} closed ${channel}` +
      (reason ? `\n**Reason:** ${reason.slice(0, 500)}` : ''),
  }).catch(() => {});

  // Lock the thread so anyone still inside it (the opener, added users)
  // can't keep typing in a closed ticket. Lock blocks non-Manage-Threads
  // sends; staff can still unlock by clicking Reopen. This is independent
  // of archiving, which we do shortly after for the visual sweep.
  try {
    if (!channel.locked) await channel.setLocked(true, 'Ticket closed');
  } catch (err) {
    console.error('Failed to lock ticket thread on close:', err);
  }

  setTimeout(async () => {
    try {
      if (!channel.archived) await channel.setArchived(true, 'Ticket closed');
    } catch (err) {
      console.error('Failed to archive ticket thread:', err);
    }
  }, 1500);
}

// ---- Reopen ----

async function handleReopen(interaction) {
  const channel = interaction.channel;
  if (!channel?.isThread || !channel.isThread()) {
    return interaction.reply({
      content: '❌ This is not a ticket thread.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // customId: ticket_reopen:<dept>   (legacy posts have plain ticket_reopen)
  const parts = interaction.customId.split(':');
  const departmentKey = parts[1] && config.departments[parts[1]] ? parts[1] : null;

  // Reopen is restricted to the same role(s) that get pinged on open
  // (admin always allowed). Falls back to general staff for legacy tickets
  // where we don't know the dept.
  const allowed = departmentKey
    ? isDeptStaff(interaction.member, departmentKey)
    : isTicketStaff(interaction.member);

  if (!allowed) {
    const dep = departmentKey ? config.departments[departmentKey] : null;
    return interaction.reply({
      content: dep
        ? `🚫 Only **${dep.label}** staff can reopen this ticket.`
        : '🚫 Only staff can reopen tickets.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    if (channel.archived) await channel.setArchived(false, `Reopened by ${interaction.user.tag}`);
    // Always clear the lock — close set it, reopen must clear it so the
    // opener and added users can post again.
    if (channel.locked) await channel.setLocked(false, `Reopened by ${interaction.user.tag}`);
  } catch (err) {
    console.error('Failed to unarchive/unlock ticket thread:', err);
  }

  const state = ticketState.get(channel.id);
  if (state && state.messageId && departmentKey) {
    // New format: clear closed flags and rebuild the merged container
    const updatedState = {
      ...state,
      closed: false,
      claimedById: null,
      closedById: undefined,
      closedReason: undefined,
      closedAt: undefined,
    };
    ticketState.set(channel.id, updatedState);
    await interaction.update({
      components: [buildTicketContainer(updatedState)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } else {
    // Legacy: replace whatever closed-state panel was clicked with a fresh open control panel
    const reopenedPanel = buildOpenControlPanel(null);
    await interaction.update({ components: [reopenedPanel], flags: MessageFlags.IsComponentsV2 });
  }

  logTicket(interaction.guild, {
    severity: 'warning',
    title: '🔓 Ticket reopened',
    description: `${interaction.user} reopened ${channel}`,
  }).catch(() => {});
}

module.exports = {
  handlePanelButton,
  handleTicketModal,
  handleClaim,
  handleAddUserButton,
  handleAddUserSelect,
  handleCloseButton,
  handleCloseModal,
  handleReopen,
};
