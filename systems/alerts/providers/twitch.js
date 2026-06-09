// systems/alerts/providers/twitch.js
const { chunk, fetchWithTimeout } = require('../utils.js');

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAppToken(clientId, clientSecret, force = false) {
  if (!force && cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  const url = 'https://id.twitch.tv/oauth2/token';
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const res = await fetchWithTimeout(url, { method: 'POST', body });
  if (!res.ok) throw new Error(`Twitch token failed: ${res.status}`);
  const json = await res.json();

  // Validate before caching: a malformed 200 (missing access_token/expires_in)
  // would otherwise poison the cache with `Bearer undefined` and a NaN expiry,
  // causing every later call to re-hit the token endpoint forever.
  if (!json.access_token) {
    cachedToken = null;
    tokenExpiresAt = 0;
    throw new Error('Twitch token response missing access_token');
  }

  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  return cachedToken;
}

function invalidateToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

async function twitchApiGet(path, clientId, token) {
  const res = await fetchWithTimeout(`https://api.twitch.tv/helix/${path}`, {
    headers: {
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const err = new Error(`Twitch API failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function resolveUser(login, clientId, clientSecret) {
  const token = await getAppToken(clientId, clientSecret);
  const json = await twitchApiGet(`users?login=${encodeURIComponent(login)}`, clientId, token);
  const u = json?.data?.[0];
  if (!u) return null;
  return { id: u.id, name: u.display_name || u.login, login: u.login };
}

// Single-broadcaster lookup. No longer used by alerts.js (the poller batches via
// getLiveStreams since the batch refactor); kept for ad-hoc/single-id callers.
async function getStreamIfLive(userId, clientId, clientSecret) {
  const token = await getAppToken(clientId, clientSecret);
  const json = await twitchApiGet(`streams?user_id=${encodeURIComponent(userId)}`, clientId, token);
  return json?.data?.[0] || null;
}

/**
 * Batch-fetch live streams for many broadcaster ids.
 * Returns Map<user_id, stream>. Only currently-live broadcasters appear.
 */
async function getLiveStreams(userIds, clientId, clientSecret, batchSize = 100) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const map = new Map();
  if (!ids.length) return map;

  let token = await getAppToken(clientId, clientSecret);

  for (const group of chunk(ids, batchSize)) {
    const qs = group.map(id => `user_id=${encodeURIComponent(id)}`).join('&');

    // Isolate each batch: one bad batch (429/5xx/network) must not discard the
    // batches already fetched or abort every other broadcaster's alert.
    try {
      const json = await twitchApiGet(`streams?${qs}`, clientId, token);
      for (const s of json?.data || []) map.set(String(s.user_id), s);
    } catch (err) {
      // A 401 means the cached token was revoked/rejected before its computed
      // expiry. Force a fresh token and retry this batch once.
      if (err.status === 401) {
        try {
          invalidateToken();
          token = await getAppToken(clientId, clientSecret, true);
          const json = await twitchApiGet(`streams?${qs}`, clientId, token);
          for (const s of json?.data || []) map.set(String(s.user_id), s);
          continue;
        } catch (retryErr) {
          console.error('Twitch batch retry failed:', retryErr.message);
          continue;
        }
      }
      console.error('Twitch batch failed:', err.message);
      continue;
    }
  }

  return map;
}

module.exports = {
  resolveUser,
  getStreamIfLive,
  getLiveStreams,
};
