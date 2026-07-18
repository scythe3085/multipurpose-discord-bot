// systems/alerts/poller.js
// The polling engine: fetches YouTube feeds / Twitch live state on a timer and
// posts alerts. Owns no SQL (goes through queries.js) and no command/interaction
// logic (that's alerts.js). The Discord client is injected via setClient() at
// init so this module has no import-time dependency on a live client.

const cfg = require('../../config/alerts.config.js');
const q = require('./queries.js');
const tw = require('./providers/twitch.js');
const websub = require('./websub.js');
const { processYoutubeChannel } = require('./youtubePipeline.js');
const { buildTwitchEmbed } = require('./embeds.js');
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
let avatarTimer = null;

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

let youtubeRunning = false;

async function pollYoutube() {
  if (youtubeRunning) return; // re-entrancy guard: a slow cycle must not overlap
  youtubeRunning = true;
  const youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
  const subs = q.getSubsForProvider('youtube');

  // Group by channel so N subs to the same channel cost ONE feed fetch and
  // ONE classification per new video.
  const byChannel = new Map();
  for (const sub of subs) {
    const list = byChannel.get(sub.sourceId) || [];
    list.push(sub);
    byChannel.set(sub.sourceId, list);
  }

  // Shared across the concurrent channel-workers below.
  const state = { posted: 0, quotaHit: false };

  try {
    await mapWithConcurrency(
      [...byChannel.entries()],
      cfg.YOUTUBE_POLL_CONCURRENCY,
      async ([channelId, channelSubs]) => {
        if (state.quotaHit) return;
        await processYoutubeChannel({
          channelId,
          subs: channelSubs,
          youtubeApiKey,
          state,
          postAlert,
        });
      },
    );
  } finally {
    youtubeRunning = false;
  }

  if (state.posted || state.quotaHit) {
    console.log(
      `[alerts] youtube poll: ${subs.length} subs / ${byChannel.size} channels, ${state.posted} posted${state.quotaHit ? ' (Data API quota exhausted — backing off)' : ''}`,
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

        const embed = buildTwitchEmbed({
          login: loginSlug,
          displayName: sub.sourceLabel,
          avatarUrl: sub.avatarUrl,
          stream,
        });

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

// Refresh stored Twitch avatars daily (one batched users call per 100 ids) so
// embed author icons don't go stale when streamers change their pfp.
async function refreshTwitchAvatars() {
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return;

  const ids = q.getDistinctSourceIds('twitch');
  if (!ids.length) return;

  try {
    const users = await tw.getUsersByIds(ids, clientId, clientSecret);
    for (const [id, u] of users) {
      q.setAvatarForSource('twitch', id, u.avatarUrl || null);
    }
  } catch (err) {
    console.error('[alerts] Twitch avatar refresh failed:', err.message);
  }
}

function startPollers() {
  if (youtubeTimer) clearInterval(youtubeTimer);
  if (twitchTimer) clearInterval(twitchTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (avatarTimer) clearInterval(avatarTimer);

  const youtubePollMs = websub.isEnabled() ? cfg.YOUTUBE_POLL_MS_WEBSUB : cfg.YOUTUBE_POLL_MS;
  youtubeTimer = setInterval(() => pollYoutube().catch(() => {}), youtubePollMs);
  twitchTimer = setInterval(() => pollTwitch().catch(() => {}), cfg.TWITCH_POLL_MS);
  pruneTimer = setInterval(q.pruneSeenItems, cfg.SEEN_PRUNE_INTERVAL_MS);
  avatarTimer = setInterval(
    () => refreshTwitchAvatars().catch(() => {}),
    cfg.TWITCH_AVATAR_REFRESH_MS,
  );

  pollYoutube().catch(() => {});
  pollTwitch().catch(() => {});
  refreshTwitchAvatars().catch(() => {});
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
  postAlert,
  isWithinReliveCooldown,
};
