// systems/alerts/utils.js
function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function uniq(arr) {
  return [...new Set(arr)];
}

function clampArray(arr, max) {
  return arr.slice(0, max);
}

function formatTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

// ISO8601 duration parser: PT#H#M#S
function isoDurationToSeconds(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}
function chunk(arr, size) {
  const out = [];
  const n = Math.max(1, size | 0);
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

// Bounded-concurrency map: runs `worker` over `items` with at most `limit`
// in flight at once, using a fixed pool of workers that pull the next index.
// Results are returned in input order. A worker that throws rejects the whole
// run (callers that want per-item isolation should catch inside the worker).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const poolSize = Math.max(1, Math.min(limit | 0 || 1, items.length));
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: poolSize }, runner));
  return results;
}

// fetch() with a hard timeout. Wraps an AbortController so no outbound call can
// hang longer than `timeoutMs` (undici's defaults are on the order of minutes).
// On timeout the underlying fetch rejects with an AbortError, which the caller
// handles like any other network failure. Honours a caller-supplied signal too.
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Read a Response body as text but stop after `maxBytes`, cancelling the stream.
// Used for the channel-page scrape, where only a small regex match near the top
// of the document is needed and the full page could otherwise buffer unbounded.
async function readTextCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.text(); // no stream support: fall back
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out += decoder.decode(value, { stream: true });
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      break;
    }
  }
  out += decoder.decode();
  return out;
}

function displayType(type) {
  switch (type) {
    case 'vod':
      return 'vid';
    case 'shorts':
      return 'short';
    case 'live':
      return 'LIVE';
    default:
      return type;
  }
}

module.exports = {
  safeJsonParse,
  uniq,
  clampArray,
  formatTemplate,
  isoDurationToSeconds,
  displayType,
  chunk,
  mapWithConcurrency,
  fetchWithTimeout,
  readTextCapped,
};
