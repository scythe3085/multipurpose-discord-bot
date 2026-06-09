// systems/tickets/ui.js
// Pure builders for the ticket UI: the public panel, the open/close modals, and
// the Components V2 ticket container (+ legacy open/closed control panels kept
// for tickets created before the merged-container layout).
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config/tickets.config.js');

async function sendTicketPanel(channel) {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${config.PANEL.title}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(config.PANEL.intro))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

  const depEntries = Object.entries(config.departments);
  depEntries.forEach(([_, dep], i) => {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${dep.label}`));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(dep.panelDescription));
    if (i < depEntries.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );
    }
  });

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

  const buttonRow = new ActionRowBuilder();
  for (const [key, dep] of depEntries) {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_open_panel:${key}`)
        .setLabel(dep.label)
        .setStyle(dep.buttonStyle || ButtonStyle.Primary),
    );
  }
  container.addActionRowComponents(buttonRow);

  await channel.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  });
}

function buildOpenTicketModal(departmentKey) {
  const dep = config.departments[departmentKey];
  const safeTitle = (dep.label || 'Ticket').slice(0, 45);

  const modal = new ModalBuilder().setCustomId(`ticket_modal:${departmentKey}`).setTitle(safeTitle);

  const rows = dep.formQuestions.map(q => {
    const safeLabel = (q.label || 'Question').slice(0, 45);
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(safeLabel)
      .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(q.required ?? false);
    if (q.placeholder) input.setPlaceholder(String(q.placeholder).slice(0, 100));
    return new ActionRowBuilder().addComponents(input);
  });

  // Optional file upload — up to 5 attachments, no required ones. FileUpload
  // components can NOT live in an ActionRowBuilder inside a modal (Discord
  // rejects with type-4-only error); they must be wrapped in a LabelBuilder
  // (Discord's modal-v2 wrapper, Oct 2025). LabelBuilder coexists with the
  // existing TextInput ActionRowBuilders at the top level.
  const fileUpload = new FileUploadBuilder()
    .setCustomId('ticket_files')
    .setMinValues(0)
    .setMaxValues(5)
    .setRequired(false);

  const fileLabel = new LabelBuilder()
    .setLabel('Attach files (optional)')
    .setDescription('Screenshots, logs, anything that helps — up to 5 files.')
    .setFileUploadComponent(fileUpload);

  modal.addComponents(...rows, fileLabel);
  return modal;
}

function buildCloseConfirmModal() {
  const modal = new ModalBuilder().setCustomId('ticket_close_modal').setTitle('Close this ticket?');

  const reason = new TextInputBuilder()
    .setCustomId('ticket_close_reason')
    .setLabel('Reason (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder('e.g. resolved, duplicate, no further action needed');

  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  return modal;
}

function buildOpenControlPanel(claimedById) {
  const claimed = !!claimedById;

  const container = new ContainerBuilder()
    .setAccentColor(
      claimed ? config.STATUS_COLORS.OPEN_CLAIMED : config.STATUS_COLORS.OPEN_UNCLAIMED,
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('### Status'))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        claimed ? `🟡 Claimed by <@${claimedById}>` : '🟢 Open · Unclaimed',
      ),
    );

  const claimButton = claimed
    ? new ButtonBuilder()
        .setCustomId(`ticket_claim:${claimedById}`)
        .setLabel('✅ Claimed (click to release)')
        .setStyle(ButtonStyle.Success)
    : new ButtonBuilder()
        .setCustomId('ticket_claim')
        .setLabel('👋 Claim')
        .setStyle(ButtonStyle.Primary);

  const addUserButton = new ButtonBuilder()
    .setCustomId('ticket_addmember_btn')
    .setLabel('➕ Add user')
    .setStyle(ButtonStyle.Secondary);

  const closeButton = new ButtonBuilder()
    .setCustomId('ticket_close')
    .setLabel('🚪 Close')
    .setStyle(ButtonStyle.Danger);

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(claimButton, addUserButton, closeButton),
  );

  return container;
}

// V2 Container has a 4000-char total text budget across ALL TextDisplays
// inside it. Fixed overhead in our card (header + status + hint) is ~600
// chars, so cap each rendered answer below half the remaining budget.
const MAX_ANSWER_DISPLAY_CHARS = 1500;

function renderedAnswer(rawText) {
  const text = (rawText || '').trim();
  if (!text) return { display: '_None provided_', truncated: false };
  if (text.length <= MAX_ANSWER_DISPLAY_CHARS) return { display: text, truncated: false };
  return {
    display:
      text.slice(0, MAX_ANSWER_DISPLAY_CHARS - 30).trimEnd() +
      '\n\n…_(truncated — full text below)_',
    truncated: true,
  };
}

// Send arbitrary-length text into a channel as one or more 2000-char-safe
// messages. Used for posting full answers when the V2 card had to truncate.
async function sendChunkedText(channel, text) {
  const MAX = 1900;
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await channel.send({ content: remaining, allowedMentions: { parse: [] } });
      return;
    }
    let cutAt = remaining.lastIndexOf('\n', MAX);
    if (cutAt < 100) cutAt = MAX;
    await channel.send({ content: remaining.slice(0, cutAt), allowedMentions: { parse: [] } });
    remaining = remaining.slice(cutAt).trim();
  }
}

// ---- Unified merged container (Q/A + status + buttons in ONE message) ----
// The current layout — one message per ticket, edited in place on status change.
// buildOpenControlPanel / buildClosedControlPanel are kept for backwards-compat
// with tickets created before the merge (no persisted state on disk).
function buildTicketContainer(state, opts = {}) {
  const dep = config.departments[state.departmentKey];
  if (!dep) throw new Error(`Unknown departmentKey: ${state.departmentKey}`);

  const claimed = !state.closed && !!state.claimedById;
  const accent = state.closed
    ? config.STATUS_COLORS.CLOSED
    : claimed
      ? config.STATUS_COLORS.OPEN_CLAIMED
      : config.STATUS_COLORS.OPEN_UNCLAIMED;

  const container = new ContainerBuilder().setAccentColor(accent);

  // Optional ping line — only on initial send. Edits omit it so we don't keep
  // re-pinging staff on every claim toggle (and allowedMentions on edits is
  // set to parse: [] as a belt-and-braces).
  if (opts.pingLine) {
    container
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(opts.pingLine))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  }

  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${dep.label}`))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Opened by <@${state.openerId}> · <t:${Math.floor(state.openedAt / 1000)}:f>`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

  // Q/A — answers are truncated to fit the 4000-char V2 budget; if any are
  // cut, the full text is posted as a plain follow-up message right after
  // this container is sent (see handleTicketModal).
  dep.formQuestions.forEach((q, i) => {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${q.label}`));
    const { display } = renderedAnswer(state.answers?.[q.id]);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(display));
    if (i < dep.formQuestions.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );
    }
  });

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

  // Status
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent('### Status'));
  if (state.closed) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🔒 Closed by <@${state.closedById}>` +
          (state.closedAt ? ` · <t:${Math.floor(state.closedAt / 1000)}:R>` : ''),
      ),
    );
    if (state.closedReason && state.closedReason.trim()) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Reason:** ${state.closedReason.trim()}`),
      );
    }
  } else if (claimed) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`🟡 Claimed by <@${state.claimedById}>`),
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('🟢 Open · Unclaimed'));
  }

  // Hint (only when open)
  if (!state.closed) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '-# 📎 Drop more screenshots, logs or files in this thread anytime — everything is saved to the transcript on close.',
        ),
      );
  }

  // Buttons
  if (state.closed) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_reopen:${state.departmentKey}`)
          .setLabel('🔓 Reopen')
          .setStyle(ButtonStyle.Success),
      ),
    );
  } else {
    const claimBtn = claimed
      ? new ButtonBuilder()
          .setCustomId(`ticket_claim:${state.departmentKey}:${state.claimedById}`)
          .setLabel('✅ Claimed (release)')
          .setStyle(ButtonStyle.Success)
      : new ButtonBuilder()
          .setCustomId(`ticket_claim:${state.departmentKey}`)
          .setLabel('👋 Claim')
          .setStyle(ButtonStyle.Primary);

    const addUserBtn = new ButtonBuilder()
      .setCustomId(`ticket_addmember_btn:${state.departmentKey}`)
      .setLabel('➕ Add user')
      .setStyle(ButtonStyle.Secondary);

    const closeBtn = new ButtonBuilder()
      .setCustomId(`ticket_close:${state.departmentKey}`)
      .setLabel('🚪 Close')
      .setStyle(ButtonStyle.Danger);

    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(claimBtn, addUserBtn, closeBtn),
    );
  }

  return container;
}

// ---- Build the closed-state control panel ----

function buildClosedControlPanel(closer, reason) {
  const container = new ContainerBuilder()
    .setAccentColor(config.STATUS_COLORS.CLOSED)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('### 🔒 Ticket closed'))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Closed by ${closer} · <t:${Math.floor(Date.now() / 1000)}:f>`,
      ),
    );

  if (reason && reason.trim()) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('### Reason'))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(reason.trim()));
  }

  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_reopen')
          .setLabel('🔓 Reopen')
          .setStyle(ButtonStyle.Success),
      ),
    );

  return container;
}

module.exports = {
  sendTicketPanel,
  buildOpenTicketModal,
  buildCloseConfirmModal,
  buildOpenControlPanel,
  renderedAnswer,
  sendChunkedText,
  buildTicketContainer,
  buildClosedControlPanel,
};
