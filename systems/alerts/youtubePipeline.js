// systems/alerts/youtubePipeline.js
// Shared per-channel YouTube pipeline: fetch a channel's feed ONCE, classify
// each new video ONCE, then fan out per subscription (seen-tracking, type
// filter, claim-before-post). Used by both the RSS poller and the WebSub push
// handler. Dependencies are injectable for tests; production callers rely on
// the defaults.

const cfg = require('../../config/alerts.config.js');
const defaultQueries = require('./queries.js');
const defaultProvider = require('./providers/youtube.js');
const { safeJsonParse, formatTemplate, displayType } = require('./utils.js');
const { buildYoutubeEmbed } = require('./embeds.js');

// channelId -> { etag, lastModified } conditional-request cache. In-memory
// only: a restart just refetches once.
const feedCache = new Map();

function _clearFeedCacheForTests() {
  feedCache.clear();
}

/** Drop the cache entry so the next fetch is unconditional (used on WebSub push). */
function bustFeedCache(channelId) {
  feedCache.delete(channelId);
}

/**
 * Process one YouTube channel for all of its subscriptions.
 * ctx: {
 *   channelId, subs, youtubeApiKey,
 *   state: { posted, quotaHit },   // shared across the whole cycle
 *   postAlert(sub, text, roleIds, embed),
 *   queries?, provider?,           // injectable for tests
 * }
 */
async function processYoutubeChannel(ctx) {
  const {
    channelId,
    subs,
    youtubeApiKey,
    state,
    postAlert,
    queries = defaultQueries,
    provider = defaultProvider,
  } = ctx;

  let feed;
  try {
    feed = await provider.fetchYoutubeFeed(channelId, feedCache.get(channelId));
  } catch (err) {
    console.error('[alerts] YouTube feed error:', channelId, err.message);
    return;
  }
  if (feed.notModified) return;
  if (feed.cacheEntry) feedCache.set(channelId, feed.cacheEntry);

  const { channelTitle, items } = feed;
  // videoId -> classified, per channel per cycle: N subs cost 1 classification.
  const classifyCache = new Map();

  for (const item of items) {
    // Quota is global to the API key — once any channel trips it, stop
    // classifying everywhere rather than burning more calls that will fail.
    if (state.quotaHit) break;
    try {
      const publishedMs = item.published ? Date.parse(item.published) : null;

      // Work out which subs still need this item BEFORE classifying, so a
      // fully-seen or pre-subscription item costs zero Data API calls.
      const pending = [];
      for (const sub of subs) {
        if (queries.hasSeen(sub.id, item.videoId)) continue;
        // Ignore videos published before the subscription was created.
        if (publishedMs && publishedMs <= sub.createdAt) {
          queries.markSeen(sub.id, item.videoId);
          continue;
        }
        pending.push(sub);
      }
      if (!pending.length) continue;

      let classified = classifyCache.get(item.videoId);
      if (!classified) {
        classified = await provider.classifyVideo(item.videoId, youtubeApiKey);
        if (!classified.error) classifyCache.set(item.videoId, classified);
      }

      // Classification failed (quota/5xx/network). Do NOT mark seen — retry
      // next cycle.
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

      for (const sub of pending) {
        const types = safeJsonParse(sub.types, []);
        if (!types.includes(type)) {
          queries.markSeen(sub.id, item.videoId);
          continue;
        }

        // Claim BEFORE posting so a race can't double-send.
        if (!queries.markSeen(sub.id, item.videoId)) continue;

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
          url: item.link,
          type: displayType(type),
        });

        const roleIds = safeJsonParse(sub.mentionRoleIds, []);
        const embed = buildYoutubeEmbed({
          channelId,
          channelTitle,
          avatarUrl: sub.avatarUrl,
          videoId: item.videoId,
          title,
          url: item.link,
          type,
          publishedMs,
          durationSec: classified.durationSec ?? null,
        });

        await postAlert(sub, text, roleIds, embed);
        state.posted++;
      }
    } catch (err) {
      // One item must never abort the rest of the channel/cycle.
      console.error('[alerts] YouTube item error:', channelId, item.videoId, err.message);
    }
  }
}

module.exports = { processYoutubeChannel, bustFeedCache, _clearFeedCacheForTests };
