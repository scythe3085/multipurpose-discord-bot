// systems/alerts/websub.js
// Opt-in YouTube WebSub (PubSubHubbub) push: near-instant upload notifications
// without polling. Entirely disabled unless WEBSUB_CALLBACK_URL is set — see
// .env.example. The notification handler re-uses the shared youtubePipeline,
// so seen_items claims make overlap with the fallback poller harmless.

const http = require('node:http');
const crypto = require('node:crypto');
const { XMLParser } = require('fast-xml-parser');

const cfg = require('../../config/alerts.config.js');
const q = require('./queries.js');
const { processYoutubeChannel, bustFeedCache } = require('./youtubePipeline.js');

const parser = new XMLParser({ ignoreAttributes: false });

let server = null;
let renewTimer = null;
let postAlertRef = null;

// channelId -> epoch ms when the hub lease expires (recorded on verification).
const leaseExpiry = new Map();

function isEnabled(env = process.env) {
  return !!(env.WEBSUB_CALLBACK_URL || '').trim();
}

function topicUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

/** Pull every yt:channelId out of an Atom notification body. */
function extractChannelIds(xml) {
  try {
    const data = parser.parse(xml);
    const feed = data.feed;
    if (!feed) return [];
    const entries = feed.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];
    return [...new Set(entries.map(e => e['yt:channelId']).filter(Boolean))];
  } catch {
    return [];
  }
}

function verifySignature(secret, rawBody, signatureHeader) {
  if (!secret) return true; // no secret configured -> nothing to verify
  const m = /^sha1=([0-9a-f]{40})$/i.exec(String(signatureHeader || ''));
  if (!m) return false;
  const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(m[1], 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Factored out so tests can spin the raw server with injected handlers.
function _createServerForTests({ secret, onNotification }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Hub verification handshake: echo hub.challenge.
    if (req.method === 'GET') {
      const challenge = url.searchParams.get('hub.challenge');
      if (challenge) {
        const lease = Number(url.searchParams.get('hub.lease_seconds')) || 0;
        const topic = url.searchParams.get('hub.topic') || '';
        const cid = /channel_id=([^&]+)/.exec(topic)?.[1];
        if (cid && lease > 0) leaseExpiry.set(cid, Date.now() + lease * 1000);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(challenge);
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Content notification.
    if (req.method === 'POST') {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > 1024 * 1024)
          req.destroy(); // 1 MB cap — real pushes are tiny
        else chunks.push(c);
      });
      req.on('end', () => {
        // Per spec always 2xx, even on drop, to avoid redelivery storms.
        res.writeHead(200);
        res.end();
        const body = Buffer.concat(chunks).toString('utf8');
        if (!verifySignature(secret, body, req.headers['x-hub-signature'])) {
          console.warn('[alerts] websub: dropped notification with bad signature');
          return;
        }
        for (const channelId of extractChannelIds(body)) {
          try {
            onNotification({ channelId });
          } catch (err) {
            console.error('[alerts] websub notification handler error:', err.message);
          }
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
}

async function handleNotification({ channelId }) {
  const subs = q.getSubsForSource('youtube', channelId);
  if (!subs.length) return;
  // The push means the feed changed — force a fresh (non-304) fetch.
  bustFeedCache(channelId);
  const state = { posted: 0, quotaHit: false };
  await processYoutubeChannel({
    channelId,
    subs,
    youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
    state,
    postAlert: postAlertRef,
  });
  if (state.posted) console.log(`[alerts] websub push: ${channelId} -> ${state.posted} posted`);
}

async function sendHubRequest(mode, channelId, env = process.env) {
  const body = new URLSearchParams({
    'hub.callback': env.WEBSUB_CALLBACK_URL.trim(),
    'hub.topic': topicUrl(channelId),
    'hub.mode': mode,
    'hub.verify': 'async',
    'hub.lease_seconds': String(cfg.WEBSUB.LEASE_SECONDS),
  });
  if ((env.WEBSUB_SECRET || '').trim()) body.set('hub.secret', env.WEBSUB_SECRET.trim());

  const res = await fetch(cfg.WEBSUB.HUB_URL, { method: 'POST', body });
  if (!res.ok && res.status !== 202 && res.status !== 204) {
    throw new Error(`hub ${mode} failed: ${res.status}`);
  }
}

/** Subscribe (or renew) one channel. Safe no-op when WebSub is disabled. */
function subscribeChannel(channelId) {
  if (!isEnabled()) return;
  sendHubRequest('subscribe', channelId).catch(err =>
    console.error('[alerts] websub subscribe failed:', channelId, err.message),
  );
}

/** Unsubscribe when the last sub for a channel is removed. Best-effort. */
function unsubscribeChannel(channelId) {
  if (!isEnabled()) return;
  if (q.getSubsForSource('youtube', channelId).length) return; // still needed
  leaseExpiry.delete(channelId);
  sendHubRequest('unsubscribe', channelId).catch(err =>
    console.error('[alerts] websub unsubscribe failed:', channelId, err.message),
  );
}

/** Subscribe anything new / renew anything close to lease expiry. */
function syncSubscriptions() {
  if (!isEnabled()) return;
  const now = Date.now();
  for (const channelId of q.getDistinctSourceIds('youtube')) {
    const expiry = leaseExpiry.get(channelId);
    if (!expiry || expiry - now < cfg.WEBSUB.RENEW_MARGIN_MS) {
      subscribeChannel(channelId);
    }
  }
}

/**
 * Start the WebSub endpoint. No-op (returns false) unless WEBSUB_CALLBACK_URL
 * is configured. postAlert is injected from the poller so this module needs no
 * Discord client of its own.
 */
function init(postAlert) {
  if (!isEnabled()) return false;
  postAlertRef = postAlert;

  const port = Number(process.env.WEBSUB_PORT) || 8080;
  const secret = (process.env.WEBSUB_SECRET || '').trim() || null;

  server = _createServerForTests({
    secret,
    onNotification: n =>
      handleNotification(n).catch(err =>
        console.error('[alerts] websub processing failed:', err.message),
      ),
  });
  server.listen(port, () => {
    console.log(`[alerts] websub endpoint listening on :${port} (push mode active)`);
  });
  server.on('error', err => console.error('[alerts] websub server error:', err.message));

  syncSubscriptions();
  renewTimer = setInterval(syncSubscriptions, cfg.WEBSUB.RENEW_CHECK_MS);
  renewTimer.unref?.();
  return true;
}

function stop() {
  if (server) server.close();
  if (renewTimer) clearInterval(renewTimer);
  server = null;
  renewTimer = null;
}

module.exports = {
  init,
  stop,
  isEnabled,
  subscribeChannel,
  unsubscribeChannel,
  syncSubscriptions,
  extractChannelIds,
  _createServerForTests,
};
