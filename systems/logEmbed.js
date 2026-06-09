// systems/logEmbed.js
// Shared compact log embed for verify + ticket events. Color-coded by severity
// so a glance at the log channel tells you what kind of event happened.

const { EmbedBuilder } = require('discord.js');

const SEVERITY_COLORS = {
  success: 0x57f287, // green
  info: 0x5865f2, // blurple
  warning: 0xfee75c, // yellow
  fail: 0xed4245, // red
};

/**
 * Build a compact log embed.
 * @param {object} opts
 * @param {'success'|'info'|'warning'|'fail'} [opts.severity='info']
 * @param {string} opts.title - one-line headline (e.g. "🆕 Ticket created")
 * @param {string} [opts.description] - optional second line of context
 * @param {Array<{name: string, value: string, inline?: boolean}>} [opts.fields=[]]
 * @param {string} [opts.footer] - small footer label (system name, etc.)
 */
function buildLogEmbed({ severity = 'info', title, description, fields = [], footer }) {
  const embed = new EmbedBuilder()
    .setColor(SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.info)
    .setTitle(title)
    .setTimestamp();

  if (description) embed.setDescription(description);
  if (fields.length) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });

  return embed;
}

/**
 * Best-effort send to a log channel. Swallows failures so logging never
 * throws and breaks the calling flow.
 */
async function sendLogEmbed(channel, opts) {
  if (!channel || !channel.isTextBased?.()) return;
  try {
    const embed = buildLogEmbed(opts);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('Failed to send log embed:', err);
  }
}

module.exports = { buildLogEmbed, sendLogEmbed, SEVERITY_COLORS };
