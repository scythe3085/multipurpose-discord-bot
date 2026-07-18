const { test } = require('node:test');
const assert = require('node:assert');
const yt = require('../systems/alerts/providers/youtube.js');

function fakeResponse({ status = 200, type = 'basic', ok, json = null, text = '' } = {}) {
  return {
    status,
    type,
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    async json() {
      return json;
    },
    async text() {
      return text;
    },
  };
}

// Routes fetch calls by URL so a single stub can serve API + probe responses.
function stubFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    for (const [needle, resp] of routes) {
      if (u.includes(needle)) return typeof resp === 'function' ? resp(u) : resp;
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return () => {
    globalThis.fetch = original;
  };
}

const apiVideo = (duration, liveBroadcastContent = 'none', liveStreamingDetails = undefined) =>
  fakeResponse({
    json: {
      items: [
        {
          snippet: { title: 'Example', liveBroadcastContent },
          contentDetails: { duration },
          ...(liveStreamingDetails ? { liveStreamingDetails } : {}),
        },
      ],
    },
  });

test('classifyVideo: 90s video that is a Short (probe 200) => shorts', async () => {
  const restore = stubFetch([
    ['googleapis.com', apiVideo('PT1M30S')],
    ['/shorts/', fakeResponse({ status: 200, type: 'basic' })],
  ]);
  try {
    const r = await yt.classifyVideo('abc', 'KEY');
    assert.strictEqual(r.type, 'shorts');
    assert.strictEqual(r.title, 'Example');
  } finally {
    restore();
  }
});

test('classifyVideo: 90s normal video (probe redirects) => vod', async () => {
  const restore = stubFetch([
    ['googleapis.com', apiVideo('PT1M30S')],
    ['/shorts/', fakeResponse({ status: 0, type: 'opaqueredirect' })],
  ]);
  try {
    const r = await yt.classifyVideo('abc', 'KEY');
    assert.strictEqual(r.type, 'vod');
  } finally {
    restore();
  }
});

test('classifyVideo: >180s video => vod without probing', async () => {
  let probed = false;
  const restore = stubFetch([
    ['googleapis.com', apiVideo('PT12M')],
    [
      '/shorts/',
      () => {
        probed = true;
        return fakeResponse({ status: 200 });
      },
    ],
  ]);
  try {
    const r = await yt.classifyVideo('abc', 'KEY');
    assert.strictEqual(r.type, 'vod');
    assert.strictEqual(probed, false, 'should not probe long videos');
  } finally {
    restore();
  }
});

test('classifyVideo: live broadcast => live', async () => {
  const restore = stubFetch([['googleapis.com', apiVideo('PT0S', 'live')]]);
  try {
    const r = await yt.classifyVideo('abc', 'KEY');
    assert.strictEqual(r.type, 'live');
  } finally {
    restore();
  }
});

test('classifyVideo: probe fails on a <=60s video => shorts (duration fallback)', async () => {
  const restore = stubFetch([
    ['googleapis.com', apiVideo('PT45S')],
    [
      '/shorts/',
      () => {
        throw new Error('blocked');
      },
    ],
  ]);
  try {
    const r = await yt.classifyVideo('abc', 'KEY');
    assert.strictEqual(r.type, 'shorts');
  } finally {
    restore();
  }
});

test('classifyVideo: probe fails on a 120s video => vod (duration fallback)', async () => {
  const restore = stubFetch([
    ['googleapis.com', apiVideo('PT2M')],
    [
      '/shorts/',
      () => {
        throw new Error('blocked');
      },
    ],
  ]);
  try {
    const r = await yt.classifyVideo('abc', 'KEY');
    assert.strictEqual(r.type, 'vod');
  } finally {
    restore();
  }
});

test('resolveChannelId: raw UC id passes through without fetching', async () => {
  const restore = stubFetch([]); // any fetch throws
  try {
    const r = await yt.resolveChannelId('UC_x5Xg1OV2P6uZZ5FSM9Ttw', 'KEY');
    assert.strictEqual(r.channelId, 'UC_x5Xg1OV2P6uZZ5FSM9Ttw');
  } finally {
    restore();
  }
});

test('resolveChannelId: /channel/UC URL passes through', async () => {
  const restore = stubFetch([]);
  try {
    const r = await yt.resolveChannelId(
      'https://www.youtube.com/channel/UC_x5Xg1OV2P6uZZ5FSM9Ttw',
      'KEY',
    );
    assert.strictEqual(r.channelId, 'UC_x5Xg1OV2P6uZZ5FSM9Ttw');
  } finally {
    restore();
  }
});

test('resolveChannelId: @handle resolves via Data API forHandle', async () => {
  const restore = stubFetch([
    ['forHandle', fakeResponse({ json: { items: [{ id: 'UChandleResolved000000' }] } })],
  ]);
  try {
    const r = await yt.resolveChannelId('@SomeCreator', 'KEY');
    assert.strictEqual(r.channelId, 'UChandleResolved000000');
    assert.strictEqual(r.label, '@SomeCreator');
  } finally {
    restore();
  }
});

test('resolveChannelId: /user/ URL resolves via forUsername', async () => {
  const restore = stubFetch([
    ['forUsername', fakeResponse({ json: { items: [{ id: 'UCuserResolved00000000' }] } })],
  ]);
  try {
    const r = await yt.resolveChannelId('https://youtube.com/user/LegacyName', 'KEY');
    assert.strictEqual(r.channelId, 'UCuserResolved00000000');
  } finally {
    restore();
  }
});

test('resolveChannelId: /c/ vanity falls back to page scrape', async () => {
  const restore = stubFetch([
    ['/c/', fakeResponse({ text: 'foo "channelId":"UCscrapedFromPage0000" bar' })],
  ]);
  try {
    const r = await yt.resolveChannelId('https://www.youtube.com/c/VanityName', 'KEY');
    assert.strictEqual(r.channelId, 'UCscrapedFromPage0000');
  } finally {
    restore();
  }
});

test('resolveChannelId: unresolvable input returns null', async () => {
  const restore = stubFetch([
    ['forHandle', fakeResponse({ json: { items: [] } })],
    ['youtube.com/@', fakeResponse({ text: 'no id here' })],
  ]);
  try {
    const r = await yt.resolveChannelId('@nope', 'KEY');
    assert.strictEqual(r, null);
  } finally {
    restore();
  }
});

test('fetchChannelAvatar returns a thumbnail url, null without key or on error', async () => {
  const restore = stubFetch([
    [
      'youtube/v3/channels',
      fakeResponse({
        json: {
          items: [
            {
              snippet: {
                thumbnails: {
                  default: { url: 'https://yt.example/d.jpg' },
                  medium: { url: 'https://yt.example/m.jpg' },
                },
              },
            },
          ],
        },
      }),
    ],
  ]);
  try {
    assert.strictEqual(await yt.fetchChannelAvatar('UCx', 'KEY'), 'https://yt.example/m.jpg');
    assert.strictEqual(await yt.fetchChannelAvatar('UCx', ''), null);
  } finally {
    restore();
  }
});

function fakeXmlResponse({ status = 200, text = '', etag = null, lastModified = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: name => {
        const n = String(name).toLowerCase();
        if (n === 'etag') return etag;
        if (n === 'last-modified') return lastModified;
        return null;
      },
    },
    async text() {
      return text;
    },
  };
}

const SAMPLE_FEED = `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <title>Chan</title>
  <entry>
    <yt:videoId>vidA</yt:videoId>
    <title>Video A</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=vidA"/>
    <published>2026-07-01T00:00:00+00:00</published>
  </entry>
</feed>`;

test('fetchYoutubeFeed: 200 returns items plus a cacheEntry with the etag', async () => {
  const restore = stubFetch([
    ['feeds/videos.xml', fakeXmlResponse({ text: SAMPLE_FEED, etag: 'W/"abc"' })],
  ]);
  try {
    const feed = await yt.fetchYoutubeFeed('UCx');
    assert.strictEqual(feed.items.length, 1);
    assert.strictEqual(feed.items[0].videoId, 'vidA');
    assert.strictEqual(feed.cacheEntry.etag, 'W/"abc"');
  } finally {
    restore();
  }
});

test('fetchYoutubeFeed: sends If-None-Match and short-circuits on 304', async () => {
  let sentHeader = null;
  const restore = stubFetch([
    [
      'feeds/videos.xml',
      () => {
        sentHeader = globalThis.__lastFetchOptions?.headers?.['If-None-Match'] ?? null;
        return fakeXmlResponse({ status: 304 });
      },
    ],
  ]);
  // wrap the stub so the second fetch arg (options) is captured
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    globalThis.__lastFetchOptions = options;
    return inner(url, options);
  };
  try {
    const feed = await yt.fetchYoutubeFeed('UCx', { etag: 'W/"abc"', lastModified: null });
    assert.strictEqual(feed.notModified, true);
    assert.strictEqual(sentHeader, 'W/"abc"');
  } finally {
    globalThis.fetch = inner;
    restore();
    delete globalThis.__lastFetchOptions;
  }
});

test('classifyVideo: vod result includes durationSec', async () => {
  const restore = stubFetch([
    ['googleapis.com', apiVideo('PT12M34S')],
    ['/shorts/', fakeResponse({ status: 0, type: 'opaqueredirect' })],
  ]);
  try {
    const r = await yt.classifyVideo('abc', 'KEY');
    assert.strictEqual(r.type, 'vod');
    assert.strictEqual(r.durationSec, 754);
  } finally {
    restore();
  }
});
