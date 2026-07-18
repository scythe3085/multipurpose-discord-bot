// systems/alerts/providers/youtube.js

const { XMLParser } = require('fast-xml-parser');
const config = require('../../../config/alerts.config.js');
const { isoDurationToSeconds, fetchWithTimeout, readTextCapped } = require('../utils.js');

const parser = new XMLParser({ ignoreAttributes: false });

// Cap the channel-page scrape: the canonical UC id sits in <head>, so a few MB
// is far more than enough and stops a pathological page buffering unbounded.
const SCRAPE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Extract a YouTube channel ID from user input
 */
function extractChannelId(inputRaw) {
  const input = (inputRaw || '').trim();

  // Direct channelId (UC...)
  if (/^UC[a-zA-Z0-9_-]{10,}$/.test(input)) return input;

  // https://www.youtube.com/channel/UCxxxx
  const m1 = input.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{10,})/i);
  if (m1) return m1[1];

  return null;
}

/**
 * Fetch RSS XML with retries + browser-like headers
 * (YouTube RSS is flaky without these)
 */
async function fetchRssTextWithRetry(url) {
  const tries = 3;
  const timeoutMs = 15000;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
        },
      });

      clearTimeout(t);

      // Retry on temporary YouTube edge errors
      if ([500, 502, 503, 504].includes(res.status)) {
        if (attempt < tries) {
          await new Promise(r => setTimeout(r, 750 * attempt));
          continue;
        }
        throw new Error(`YouTube RSS fetch failed: ${res.status}`);
      }

      if (!res.ok) {
        throw new Error(`YouTube RSS fetch failed: ${res.status}`);
      }

      return await res.text();
    } catch (err) {
      clearTimeout(t);
      if (attempt >= tries) throw err;
      await new Promise(r => setTimeout(r, 750 * attempt));
    }
  }

  throw new Error('YouTube RSS fetch failed');
}

/**
 * Fetch and parse a YouTube channel RSS feed
 */
async function fetchYoutubeFeed(channelId) {
  const id = (channelId || '').trim();

  // Try both hosts (some networks behave differently)
  const urls = [
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`,
    `https://youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`,
  ];

  let xml = null;
  let lastErr = null;

  for (const url of urls) {
    try {
      xml = await fetchRssTextWithRetry(url);
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!xml) throw lastErr || new Error('YouTube RSS fetch failed');

  const data = parser.parse(xml);

  const feed = data.feed;
  const entries = feed?.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];

  const channelTitle = feed?.title || 'YouTube';

  const items = entries
    .slice(0, config.MAX_FEED_ITEMS_TO_CHECK)
    .map(e => {
      const videoId = e['yt:videoId'];
      const title = e.title;
      const link =
        e.link?.['@_href'] || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
      const published = e.published || null;

      return { videoId, title, link, published };
    })
    .filter(x => x.videoId && x.link)
    // RSS is newest-first; reverse so the poller processes oldest-first.
    // This yields correct chronological alert ordering and stops a burst of
    // uploads from starving the older unseen items below a slice cutoff.
    .reverse();

  return { channelTitle, items };
}

/**
 * Probe whether a video is a Short by requesting its /shorts/ URL.
 * Real Shorts return HTTP 200; normal videos redirect to /watch.
 * Returns true (short), false (not short), or null (inconclusive / blocked).
 */
async function probeIsShort(videoId) {
  const url = `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    clearTimeout(t);

    // Always drain/cancel the body (no-op-safe on opaqueredirect) so undici's
    // keep-alive sockets/buffers aren't pinned across the many probes per poll.
    res.body?.cancel?.();

    // undici returns an opaque redirect (status 0, type "opaqueredirect");
    // other runtimes may surface the real 3xx status. Treat both as "not a short".
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return false;
    }
    if (res.status === 200) {
      return true;
    }
    return null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

/**
 * Classify a video as live / upcoming / shorts / vod.
 * Uses the Data API for live detection + title, then the /shorts/ probe to
 * split Shorts from normal videos, with a duration-based fallback.
 *
 * Return shape: { type, title, error? }
 *  - type "upcoming": a premiere / scheduled stream that has NOT started yet.
 *    Callers should skip it WITHOUT marking it seen so it can re-fire when live.
 *  - error set (type null): the Data API call failed (e.g. 403 quotaExceeded
 *    or a transient 5xx). Callers must NOT mark the item seen so it retries.
 *    classifyVideo never throws on an API error — it degrades instead.
 */
async function classifyVideo(videoId, youtubeApiKey) {
  // No API key: can't detect live, but can still split short vs vod via probe.
  // If the probe is inconclusive (null: blocked/timeout), default to vod —
  // there is no duration available to fall back on without the API.
  if (!youtubeApiKey) {
    const isShort = await probeIsShort(videoId);
    return { type: isShort === true ? 'shorts' : 'vod', title: null };
  }

  const apiUrl =
    'https://www.googleapis.com/youtube/v3/videos' +
    `?part=snippet,contentDetails,liveStreamingDetails` +
    `&id=${encodeURIComponent(videoId)}` +
    `&key=${encodeURIComponent(youtubeApiKey)}`;

  let res;
  try {
    res = await fetchWithTimeout(apiUrl);
  } catch (err) {
    // Network error: degrade, don't throw — caller retries next cycle.
    return { type: null, title: null, error: `network: ${err.message}` };
  }
  if (!res.ok) {
    // A 403 here is almost always quotaExceeded; surface the status so the
    // poller can recognise it instead of swallowing a generic throw.
    return { type: null, title: null, error: `videos.list ${res.status}` };
  }

  const json = await res.json();
  const v = json?.items?.[0];
  if (!v) return { type: 'vod', title: null };

  const snippet = v.snippet || {};
  const contentDetails = v.contentDetails || {};
  const liveStreamingDetails = v.liveStreamingDetails || null;

  const title = snippet.title || null;
  const liveBroadcastContent = snippet.liveBroadcastContent; // none | live | upcoming
  const durationSec = isoDurationToSeconds(contentDetails.duration);

  // A stream/premiere that is scheduled but not yet started.
  if (liveBroadcastContent === 'upcoming') return { type: 'upcoming', title };

  // Genuinely live right now. Note: liveStreamingDetails ALSO persists on the
  // finished archive (VOD) of a past stream, so a bare `!!liveStreamingDetails`
  // would mis-tag old VODs as live. Require an actual start with no end.
  const isLiveNow =
    liveBroadcastContent === 'live' ||
    !!(
      liveStreamingDetails &&
      liveStreamingDetails.actualStartTime &&
      !liveStreamingDetails.actualEndTime
    );

  if (isLiveNow) return { type: 'live', title };

  // Longer than the max Short length => definitely a normal video; skip the probe.
  if (typeof durationSec === 'number' && durationSec > config.SHORTS_MAX_DURATION) {
    return { type: 'vod', title };
  }

  // Ambiguous (<= 180s or unknown duration): probe the /shorts/ URL.
  const isShort = await probeIsShort(videoId);
  if (isShort === true) return { type: 'shorts', title };
  if (isShort === false) return { type: 'vod', title };

  // Probe inconclusive: fall back to the legacy heuristic (Shorts were <=60s
  // before the probe existed). Deliberately 60s, not SHORTS_MAX_DURATION.
  if (typeof durationSec === 'number' && durationSec <= 60) {
    return { type: 'shorts', title };
  }
  return { type: 'vod', title };
}

/** Look up a channel id from the Data API channels endpoint. */
async function apiChannelId(queryParam, apiKey) {
  const url =
    'https://www.googleapis.com/youtube/v3/channels' +
    `?part=id&${queryParam}&key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.items?.[0]?.id || null;
  } catch {
    return null;
  }
}

/** Fetch a channel page and scrape its canonical UC id. */
async function scrapeChannelId(pageUrl) {
  try {
    const res = await fetchWithTimeout(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await readTextCapped(res, SCRAPE_MAX_BYTES);
    const m =
      html.match(/"(?:channelId|externalId)":"(UC[a-zA-Z0-9_-]{10,})"/) ||
      html.match(/channel\/(UC[a-zA-Z0-9_-]{10,})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve any YouTube channel reference to a UC id.
 * Accepts UC ids, /channel/ URLs, @handles, /user/ and /c/ URLs.
 * Returns { channelId, label } or null.
 */
async function resolveChannelId(inputRaw, apiKey) {
  const input = (inputRaw || '').trim();
  if (!input) return null;

  // 1) Direct UC id or /channel/UC... URL
  const direct = extractChannelId(input);
  if (direct) return { channelId: direct, label: direct };

  // 2) Identify handle / legacy username / vanity from URL or bare text
  let handle = null;
  let username = null;
  let vanity = null;

  const urlAt = input.match(/youtube\.com\/@([a-zA-Z0-9._-]+)/i);
  const urlUser = input.match(/youtube\.com\/user\/([a-zA-Z0-9._-]+)/i);
  const urlC = input.match(/youtube\.com\/c\/([a-zA-Z0-9._-]+)/i);

  if (urlAt) handle = urlAt[1];
  else if (urlUser) username = urlUser[1];
  else if (urlC) vanity = urlC[1];
  else if (input.startsWith('@')) handle = input.slice(1);
  else if (/^[a-zA-Z0-9._-]+$/.test(input)) handle = input; // bare name -> try as handle

  // 3) Resolve via Data API
  if (apiKey && handle) {
    const id = await apiChannelId(`forHandle=@${encodeURIComponent(handle)}`, apiKey);
    if (id) return { channelId: id, label: `@${handle}` };
  }
  if (apiKey && username) {
    const id = await apiChannelId(`forUsername=${encodeURIComponent(username)}`, apiKey);
    if (id) return { channelId: id, label: username };
  }

  // 4) Page-scrape fallback. This is the ONLY path for /c/ vanity URLs —
  //    the Data API has no "forVanity" lookup, so vanity slugs skip step 3.
  const pageUrl = handle
    ? `https://www.youtube.com/@${handle}`
    : vanity
      ? `https://www.youtube.com/c/${vanity}`
      : username
        ? `https://www.youtube.com/user/${username}`
        : null;

  if (pageUrl) {
    const id = await scrapeChannelId(pageUrl);
    if (id) {
      return {
        channelId: id,
        label: handle ? `@${handle}` : vanity || username,
      };
    }
  }

  return null;
}

/**
 * Fetch a channel's avatar thumbnail via the Data API. Best-effort: returns
 * null without an API key or on any failure (the embed just omits the icon).
 */
async function fetchChannelAvatar(channelId, apiKey) {
  if (!apiKey) return null;
  const url =
    'https://www.googleapis.com/youtube/v3/channels' +
    `?part=snippet&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json = await res.json();
    const thumbs = json?.items?.[0]?.snippet?.thumbnails;
    return thumbs?.medium?.url || thumbs?.default?.url || null;
  } catch {
    return null;
  }
}

module.exports = {
  extractChannelId,
  resolveChannelId,
  fetchYoutubeFeed,
  classifyVideo,
  probeIsShort,
  fetchChannelAvatar,
};
