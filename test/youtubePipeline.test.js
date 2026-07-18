const { test } = require('node:test');
const assert = require('node:assert');
const {
  processYoutubeChannel,
  _clearFeedCacheForTests,
} = require('../systems/alerts/youtubePipeline.js');

function makeSub(over = {}) {
  return {
    id: over.id || 'sub1',
    guildId: 'g1',
    sourceId: 'UCx',
    types: JSON.stringify(over.types || ['vod']),
    mentionRoleIds: '[]',
    createdAt: 0,
    customTemplate: null,
    avatarUrl: null,
    ...over,
  };
}

function makeFakeQueries() {
  const seen = new Set();
  return {
    seen,
    hasSeen: (subId, itemId) => seen.has(`${subId}:${itemId}`),
    markSeen: (subId, itemId) => {
      const k = `${subId}:${itemId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
  };
}

const FEED = {
  channelTitle: 'Chan',
  items: [
    { videoId: 'v1', title: 'One', link: 'https://youtu.be/v1', published: '2026-07-01T00:00:00Z' },
  ],
  cacheEntry: { etag: 'W/"x"', lastModified: null },
};

test('classifies once per video even with many subs, posts to each', async () => {
  _clearFeedCacheForTests();
  let classifyCalls = 0;
  const posts = [];
  const state = { posted: 0, quotaHit: false };
  await processYoutubeChannel({
    channelId: 'UCx',
    subs: [makeSub({ id: 'a' }), makeSub({ id: 'b' })],
    youtubeApiKey: 'KEY',
    state,
    postAlert: async (sub, text, roleIds, embed) => posts.push({ sub: sub.id, text }),
    queries: makeFakeQueries(),
    provider: {
      fetchYoutubeFeed: async () => FEED,
      classifyVideo: async () => (classifyCalls++, { type: 'vod', title: 'One', durationSec: 60 }),
    },
  });
  assert.strictEqual(classifyCalls, 1, 'one classification for two subs');
  assert.deepStrictEqual(posts.map(p => p.sub).sort(), ['a', 'b']);
  assert.strictEqual(state.posted, 2);
});

test('fully-seen items cost zero classifications', async () => {
  _clearFeedCacheForTests();
  let classifyCalls = 0;
  const q = makeFakeQueries();
  q.markSeen('a', 'v1');
  const state = { posted: 0, quotaHit: false };
  await processYoutubeChannel({
    channelId: 'UCx',
    subs: [makeSub({ id: 'a' })],
    youtubeApiKey: 'KEY',
    state,
    postAlert: async () => {},
    queries: q,
    provider: {
      fetchYoutubeFeed: async () => FEED,
      classifyVideo: async () => (classifyCalls++, { type: 'vod', title: 'One' }),
    },
  });
  assert.strictEqual(classifyCalls, 0);
  assert.strictEqual(state.posted, 0);
});

test('type filter marks seen without posting; quota 403 sets quotaHit', async () => {
  _clearFeedCacheForTests();
  const q = makeFakeQueries();
  const state = { posted: 0, quotaHit: false };
  await processYoutubeChannel({
    channelId: 'UCx',
    subs: [makeSub({ id: 'a', types: ['live'] })],
    youtubeApiKey: 'KEY',
    state,
    postAlert: async () => {
      throw new Error('must not post');
    },
    queries: q,
    provider: {
      fetchYoutubeFeed: async () => FEED,
      classifyVideo: async () => ({ type: 'vod', title: 'One' }),
    },
  });
  assert.strictEqual(q.hasSeen('a', 'v1'), true, 'filtered item is marked seen');

  const state2 = { posted: 0, quotaHit: false };
  await processYoutubeChannel({
    channelId: 'UCy',
    subs: [makeSub({ id: 'b', sourceId: 'UCy' })],
    youtubeApiKey: 'KEY',
    state: state2,
    postAlert: async () => {},
    queries: makeFakeQueries(),
    provider: {
      fetchYoutubeFeed: async () => FEED,
      classifyVideo: async () => ({ type: null, title: null, error: 'videos.list 403' }),
    },
  });
  assert.strictEqual(state2.quotaHit, true);
});

test('items older than sub.createdAt are marked seen without classify', async () => {
  _clearFeedCacheForTests();
  let classifyCalls = 0;
  const q = makeFakeQueries();
  const state = { posted: 0, quotaHit: false };
  await processYoutubeChannel({
    channelId: 'UCx',
    subs: [makeSub({ id: 'a', createdAt: Date.parse('2027-01-01T00:00:00Z') })],
    youtubeApiKey: 'KEY',
    state,
    postAlert: async () => {},
    queries: q,
    provider: {
      fetchYoutubeFeed: async () => FEED,
      classifyVideo: async () => (classifyCalls++, { type: 'vod' }),
    },
  });
  assert.strictEqual(classifyCalls, 0);
  assert.strictEqual(q.hasSeen('a', 'v1'), true);
});

test('notModified feed result is a no-op', async () => {
  _clearFeedCacheForTests();
  const state = { posted: 0, quotaHit: false };
  await processYoutubeChannel({
    channelId: 'UCx',
    subs: [makeSub()],
    youtubeApiKey: 'KEY',
    state,
    postAlert: async () => {
      throw new Error('must not post');
    },
    queries: makeFakeQueries(),
    provider: {
      fetchYoutubeFeed: async () => ({ notModified: true }),
      classifyVideo: async () => {
        throw new Error('must not classify');
      },
    },
  });
  assert.strictEqual(state.posted, 0);
});
