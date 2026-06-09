// systems/alerts/poller.js
// The polling engine: fetches YouTube feeds / Twitch live state on a timer and
// posts alerts. Owns no SQL (goes through queries.js) and no command/interaction
// logic (that's alerts.js). The Discord client is injected via setClient() at
// init so this module has no import-time dependency on a live client.

const { EmbedBuilder } = require('discord.js');

const cfg = require('../../config/alerts.config.js');
const q = require('./queries.js');
const yt = require('./providers/youtube.js');
const tw = require('./providers/twitch.js');
const {
  safeJsonParse,
  uniq,
  clampArray,
  formatTemplate,
  displayType,
  mapWithConcurrency,
} = require('./utils.js');

let clientRef = null;
let youtubeTimer = null;
let twitchTimer = null;
let pruneTimer = null;

function setClient(client) {
  clientRef = client;
}

// True if the same broadcaster alerted within the relive cooldown window
// (i.e. this "new" stream id is almost certainly a brief reconnect).
function isWithinReliveCooldown(lastLiveAlertAt, now, cooldownMs) {
  return !!(lastLiveAlertAt && now - lastLiveAlertAt < cooldownMs);
}

async function postAlert(sub, text, roleIds, embed = null) {
  const guild = clientRef.guilds.cache.get(sub.guildId);
  if (!guild) return;

  const channel = guild.channels.cache.get(sub.discordChannelId);
  if (!channel || !channel.isTextBased()) return;

  const roles = clampArray(uniq(roleIds || []), cfg.MAX_ROLE_MENTIONS);
  const roleMentions = roles.length ? roles.map(id => `<@&${id}>`).join(' ') + '\n' : '';

  const payload = {
    content: roleMentions + text,
    allowedMentions: { roles, parse: [] },
  };

  if (embed) payload.embeds = [embed];

  await channel.send(payload);
}

// Process one YouTube subscription: fetch its feed and walk the items
// oldest-first. Items stay serial within a sub so ordering and the per-cycle
// quota backoff are preserved. `state` is shared across all concurrent subs in
// a cycle: { posted, quotaHit }. Mutations are plain synchronous writes between
// awaits, so there's no race even though subs run concurrently.
async function processYoutubeSub(sub, youtubeApiKey, state) {
  const types = safeJsonParse(sub.types, []);
  const roleIds = safeJsonParse(sub.mentionRoleIds, []);

  let feed;
  try {
    feed = await yt.fetchYoutubeFeed(sub.sourceId);
  } catch (err) {
    console.error('[alerts] YouTube feed error:', sub.guildId, sub.sourceId, err.message);
    return;
  }

  const { channelTitle, items } = feed;

  for (const item of items) {
    // Quota is global to the API key — once any sub trips it, stop classifying
    // here too rather than burning more quota on calls that will also fail.
    if (state.quotaHit) break;
    try {
      if (q.hasSeen(sub.id, item.videoId)) continue;

      const publishedMs = item.published ? Date.parse(item.published) : null;

      // Ignore videos published before the subscription was created.
      if (publishedMs && publishedMs <= sub.createdAt) {
        q.markSeen(sub.id, item.videoId);
        continue;
      }

      const classified = await yt.classifyVideo(item.videoId, youtubeApiKey);

      // Classification failed (quota/5xx/network). Do NOT mark seen — retry
      // next cycle. If it's a quota error, stop classifying this whole cycle
      // so we don't burn more quota hammering the same failing call.
      if (classified.error) {
        if (/\b403\b/.test(classified.error)) state.quotaHit = true;
        console.error('[alerts] YouTube classify failed:', item.videoId, classified.error);
        if (state.quotaHit) break;
        continue;
      }

      // Scheduled premiere / not-yet-started stream: skip WITHOUT marking
      // seen so it fires when it actually flips to live.
      if (classified.type === 'upcoming') continue;

      const type = classified.type || 'vod';
      const title = classified.title || item.title || 'New upload';
      const url = item.link;

      if (!types.includes(type)) {
        q.markSeen(sub.id, item.videoId);
        continue;
      }

      // Claim BEFORE posting so a race can't double-send. If another cycle
      // already claimed it, skip. A send failure after claiming costs at
      // most one missed alert — preferable to a duplicate.
      if (!q.markSeen(sub.id, item.videoId)) continue;

      const template =
        (sub.customTemplate && String(sub.customTemplate).trim().length
          ? sub.customTemplate
          : null) ||
        cfg.TEMPLATES.youtube[type] ||
        cfg.TEMPLATES.youtube.vod;

      const text = formatTemplate(template, {
        name: channelTitle,
        channel: channelTitle, // legacy support
        title,
        url,
        type: displayType(type),
      });

      const embed = new EmbedBuilder()
        .setAuthor({ name: String(channelTitle).slice(0, 256) })
        .setTitle(String(title).slice(0, 256))
        .setURL(url)
        .setColor(cfg.COLORS.youtube[type] ?? cfg.COLORS.youtube.vod)
        .setImage(`https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/hqdefault.jpg`)
        .setTimestamp(publishedMs ? new Date(publishedMs) : new Date());

      await postAlert(sub, text, roleIds, embed);
      state.posted++;
    } catch (err) {
      // One item must never abort the rest of the sub/cycle.
      console.error('[alerts] YouTube item error:', sub.sourceId, item.videoId, err.message);
    }
  }
}

let youtubeRunning = false;

async function pollYoutube() {
  if (youtubeRunning) return; // re-entrancy guard: a slow cycle must not overlap
  youtubeRunning = true;
  const youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
  const subs = q.getSubsForProvider('youtube');

  // Shared across the concurrent sub-workers below.
  const state = { posted: 0, quotaHit: false };

  try {
    // Poll subscriptions concurrently (bounded) instead of one-at-a-time, so the
    // cycle overlaps network waits rather than summing them. Once quota is hit,
    // already-running subs wind down (they check state.quotaHit) and no new sub
    // starts its work.
    await mapWithConcurrency(subs, cfg.YOUTUBE_POLL_CONCURRENCY, async sub => {
      if (state.quotaHit) return;
      await processYoutubeSub(sub, youtubeApiKey, state);
    });
  } finally {
    youtubeRunning = false;
  }

  if (state.posted || state.quotaHit) {
    console.log(
      `[alerts] youtube poll: ${subs.length} subs, ${state.posted} posted${state.quotaHit ? ' (Data API quota exhausted — backing off)' : ''}`,
    );
  }
}

let twitchRunning = false;

async function pollTwitch() {
  if (twitchRunning) return; // re-entrancy guard
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return;

  const subs = q.getSubsForProvider('twitch').filter(sub => {
    const types = safeJsonParse(sub.types, []);
    return types.includes('live');
  });
  if (!subs.length) return;

  twitchRunning = true;
  let posted = 0;
  try {
    let liveMap;
    try {
      const userIds = subs.map(s => s.sourceId);
      // getLiveStreams is now per-batch resilient and returns whatever it could
      // fetch, so a single bad batch no longer blanks the whole cycle.
      liveMap = await tw.getLiveStreams(userIds, clientId, clientSecret, cfg.TWITCH_BATCH_SIZE);
    } catch (err) {
      console.error('[alerts] Twitch batch poll error:', err.message);
      return;
    }

    for (const sub of subs) {
      try {
        const stream = liveMap.get(String(sub.sourceId));
        if (!stream) continue;

        const streamId = stream.id;
        if (q.hasSeen(sub.id, streamId)) continue;

        // A brief drop/reconnect mints a fresh stream id. If we already alerted
        // for this broadcaster very recently, treat it as the same session:
        // record the id as seen (so we don't reconsider it) and skip the alert.
        if (
          isWithinReliveCooldown(sub.lastLiveAlertAt, Date.now(), cfg.TWITCH_RELIVE_COOLDOWN_MS)
        ) {
          q.markSeen(sub.id, streamId);
          continue;
        }

        const roleIds = safeJsonParse(sub.mentionRoleIds, []);
        // URL needs the lowercase login slug. New rows store it in sourceLogin;
        // pre-migration rows kept the login in sourceLabel.
        const loginSlug = sub.sourceLogin || sub.sourceLabel;
        const url = `https://twitch.tv/${encodeURIComponent(loginSlug)}`;

        const template =
          (sub.customTemplate && String(sub.customTemplate).trim().length
            ? sub.customTemplate
            : null) || cfg.TEMPLATES.twitch.live;

        const text = formatTemplate(template, {
          name: sub.sourceLabel, // display name (cased) for new rows
          url,
          type: displayType('live'),
        });

        const embed = new EmbedBuilder()
          .setTitle(
            stream.title ? String(stream.title).slice(0, 256) : '\uD83D\uDD34 Live on Twitch',
          )
          .setURL(url)
          .setColor(cfg.COLORS.twitch?.live ?? 0x9146ff)
          .setTimestamp();

        // Only set an image when a real thumbnail exists — Helix occasionally
        // omits thumbnail_url right at go-live, and "?cb=123" is an invalid URL
        // that would throw inside setImage and silently drop the alert.
        const thumbBase = String(stream.thumbnail_url || '');
        if (thumbBase) {
          const thumb =
            thumbBase.replace('{width}', '1280').replace('{height}', '720') + `?cb=${Date.now()}`;
          embed.setImage(thumb);
        }

        if (stream.game_name) {
          embed.addFields({
            name: 'Category',
            value: String(stream.game_name).slice(0, 1024),
            inline: true,
          });
        }
        if (typeof stream.viewer_count === 'number') {
          embed.addFields({
            name: 'Viewers',
            value: stream.viewer_count.toLocaleString('en-US'),
            inline: true,
          });
        }

        // Claim before posting to avoid a double-alert race.
        if (!q.markSeen(sub.id, streamId)) continue;

        await postAlert(sub, text, roleIds, embed);
        q.setLastLiveAlert(sub.id, Date.now()); // arms the relive cooldown
        posted++;
      } catch (err) {
        console.error('[alerts] Twitch poll error:', sub.guildId, sub.sourceId, err.message);
      }
    }
  } finally {
    twitchRunning = false;
  }

  if (posted) console.log(`[alerts] twitch poll: ${subs.length} subs, ${posted} posted`);
}

function startPollers() {
  if (youtubeTimer) clearInterval(youtubeTimer);
  if (twitchTimer) clearInterval(twitchTimer);
  if (pruneTimer) clearInterval(pruneTimer);

  youtubeTimer = setInterval(() => pollYoutube().catch(() => {}), cfg.YOUTUBE_POLL_MS);
  twitchTimer = setInterval(() => pollTwitch().catch(() => {}), cfg.TWITCH_POLL_MS);
  pruneTimer = setInterval(q.pruneSeenItems, cfg.SEEN_PRUNE_INTERVAL_MS);

  pollYoutube().catch(() => {});
  pollTwitch().catch(() => {});
  q.pruneSeenItems();
}

// Warn loudly (but don't crash) when a key is missing — otherwise the bot looks
// healthy under pm2 while silently never alerting / running in a degraded mode.
function validateAlertsEnv() {
  if (!process.env.YOUTUBE_API_KEY) {
    console.warn(
      '[alerts] YOUTUBE_API_KEY not set — live/upcoming detection disabled; ' +
        'Shorts vs video falls back to the /shorts/ probe only.',
    );
  }
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.warn(
      '[alerts] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set — Twitch alerts disabled.',
    );
  }
}

module.exports = {
  setClient,
  startPollers,
  validateAlertsEnv,
  pollYoutube,
  pollTwitch,
  isWithinReliveCooldown,
};
