// config/alerts.config.js
module.exports = {
  // Poll intervals (ms)
  YOUTUBE_POLL_MS: 60 * 1000, // 1 min (channel-deduped + conditional GETs keep this cheap)
  // Fallback interval when WebSub push is active — polling stays on only as a
  // safety net, so it can be much lazier.
  YOUTUBE_POLL_MS_WEBSUB: 5 * 60 * 1000, // 5 min
  TWITCH_POLL_MS: 30 * 1000, // 30s (batched single Helix call; dedup + relive cooldown keep it duplicate-safe)

  // Limits
  MAX_ROLE_MENTIONS: 10,
  // Process the full RSS feed window (YouTube caps the feed at ~15 entries).
  // Lower values can permanently miss uploads if a channel posts a burst
  // between two polls — see the oldest-first processing in youtube.js.
  MAX_FEED_ITEMS_TO_CHECK: 15,

  // Max alert subscriptions per guild (prevents Data API / fetch abuse).
  MAX_SUBS_PER_GUILD: 25,

  // How many YouTube subscriptions to poll concurrently per cycle. The old loop
  // was fully serial: total cycle time ≈ sum of every feed+classify round-trip,
  // which grows linearly with subscriptions. A small worker pool overlaps the
  // network waits. Kept modest so a cycle never fans out a burst of Data API
  // calls large enough to trip quota or rate limits. Items WITHIN a sub stay
  // serial (preserves oldest-first ordering and the per-cycle quota backoff).
  YOUTUBE_POLL_CONCURRENCY: 4,

  // seen_items retention: prune rows older than this on a daily sweep.
  // Far longer than any feed lookback, so re-alerting old items is impossible.
  SEEN_RETENTION_DAYS: 90,
  SEEN_PRUNE_INTERVAL_MS: 24 * 60 * 60 * 1000, // once a day

  // YouTube Shorts max length (seconds). Anything longer cannot be a Short.
  SHORTS_MAX_DURATION: 180,

  // Twitch Helix `streams` accepts up to 100 user_id params per call.
  TWITCH_BATCH_SIZE: 100,

  // Suppress a repeat "is LIVE" alert if the same broadcaster goes live again
  // within this window. A brief drop/reconnect mints a NEW stream id, which
  // would otherwise re-alert; this collapses it to one alert per session.
  TWITCH_RELIVE_COOLDOWN_MS: 30 * 60 * 1000, // 30 min

  // Embed accent colors per alert type
  COLORS: {
    youtube: { live: 0xff0000, shorts: 0xff2d55, vod: 0x3ba3ff },
    twitch: { live: 0x9146ff },
  },

  // Templates (NO literal emojis in this repo: use unicode escapes)
  TEMPLATES: {
    youtube: {
      vod: '\uD83D\uDCFA **New YouTube video!**\n{title}\n{url}', // 📺
      live: '\uD83D\uDD34 **YouTube LIVE**\n{title}\n{url}', // 🔴
      shorts: '\uD83E\uDE73 **New YouTube Short!**\n{title}\n{url}', // 🩳
    },
    twitch: {
      live: '\uD83D\uDD34 **{name} is LIVE on Twitch!**\n{url}', // 🔴
    },
  },
};
