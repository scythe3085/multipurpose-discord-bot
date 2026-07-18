// systems/alerts/embeds.js
// Pure embed builders for alert posts. No Discord client, no DB — everything
// arrives as arguments so these are trivially unit-testable.

const { EmbedBuilder } = require('discord.js');
const cfg = require('../../config/alerts.config.js');

function trunc(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// 754 -> "12:34", 3754 -> "1:02:34"
function formatClock(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function buildYoutubeEmbed({
  channelId,
  channelTitle,
  avatarUrl,
  videoId,
  title,
  url,
  type,
  publishedMs,
  durationSec,
}) {
  const embed = new EmbedBuilder()
    .setColor(cfg.COLORS.youtube[type] ?? cfg.COLORS.youtube.vod)
    .setAuthor({
      name: trunc(channelTitle || 'YouTube', 256),
      url: channelId
        ? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`
        : undefined,
      iconURL: avatarUrl || undefined,
    })
    .setTitle(trunc(title || 'New upload', 256))
    .setURL(url)
    .setImage(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`)
    .setFooter({
      text:
        type === 'live' ? 'YouTube · Live now' : type === 'shorts' ? 'YouTube Shorts' : 'YouTube',
    })
    .setTimestamp(publishedMs ? new Date(publishedMs) : new Date());

  if (type === 'vod' && typeof durationSec === 'number' && durationSec > 0) {
    embed.addFields({ name: 'Duration', value: formatClock(durationSec), inline: true });
  }
  return embed;
}

function buildTwitchEmbed({ login, displayName, avatarUrl, stream }) {
  const url = `https://twitch.tv/${encodeURIComponent(login)}`;
  const embed = new EmbedBuilder()
    .setColor(cfg.COLORS.twitch?.live ?? 0x9146ff)
    .setAuthor({
      name: trunc(`${displayName || login} is LIVE`, 256),
      url,
      iconURL: avatarUrl || undefined,
    })
    .setTitle(trunc(stream.title || '🔴 Live on Twitch', 256))
    .setURL(url);

  // Helix occasionally omits thumbnail_url right at go-live; "?cb=" busts the
  // CDN cache so the preview isn't a stale offline frame.
  const thumbBase = String(stream.thumbnail_url || '');
  if (thumbBase) {
    embed.setImage(
      thumbBase.replace('{width}', '1280').replace('{height}', '720') + `?cb=${Date.now()}`,
    );
  }
  if (stream.game_id) {
    embed.setThumbnail(
      `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(stream.game_id)}-144x192.jpg`,
    );
  }
  if (stream.game_name) {
    embed.addFields({ name: 'Category', value: trunc(stream.game_name, 1024), inline: true });
  }
  if (typeof stream.viewer_count === 'number') {
    embed.addFields({
      name: 'Viewers',
      value: stream.viewer_count.toLocaleString('en-US'),
      inline: true,
    });
  }
  const startedMs = stream.started_at ? Date.parse(stream.started_at) : NaN;
  if (!Number.isNaN(startedMs)) {
    embed.addFields({
      name: 'Started',
      value: `<t:${Math.floor(startedMs / 1000)}:R>`,
      inline: true,
    });
    embed.setTimestamp(new Date(startedMs));
  } else {
    embed.setTimestamp();
  }
  return embed;
}

module.exports = { buildYoutubeEmbed, buildTwitchEmbed };
