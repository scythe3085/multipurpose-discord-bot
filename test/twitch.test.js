const { test } = require('node:test');
const assert = require('node:assert');
const tw = require('../systems/alerts/providers/twitch.js');

function fakeResponse({ status = 200, json = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return json;
    },
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

test('getLiveStreams batches ids and maps by user_id', async () => {
  const calls = [];
  const restore = stubFetch(async url => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      return fakeResponse({ json: { access_token: 'tok', expires_in: 3600 } });
    }
    calls.push(u);
    return fakeResponse({
      json: {
        data: [
          { id: 's1', user_id: '1', title: 'A' },
          { id: 's2', user_id: '3', title: 'B' },
        ],
      },
    });
  });
  try {
    const map = await tw.getLiveStreams(['1', '2', '3', '1'], 'cid', 'secret', 100);
    assert.strictEqual(map.get('1').id, 's1');
    assert.strictEqual(map.get('3').id, 's2');
    assert.strictEqual(map.has('2'), false); // not live
    assert.strictEqual(calls.length, 1, 'deduped 4 ids into one batched call');
    assert.ok(calls[0].includes('user_id=1'));
    assert.ok(calls[0].includes('user_id=3'));
  } finally {
    restore();
  }
});

test('getLiveStreams splits into multiple calls when over batch size', async () => {
  let streamCalls = 0;
  const restore = stubFetch(async url => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      return fakeResponse({ json: { access_token: 'tok', expires_in: 3600 } });
    }
    streamCalls++;
    return fakeResponse({ json: { data: [] } });
  });
  try {
    await tw.getLiveStreams(['a', 'b', 'c'], 'cid', 'secret', 2);
    assert.strictEqual(streamCalls, 2, '3 ids with size 2 => 2 calls');
  } finally {
    restore();
  }
});

test('getLiveStreams returns empty map for no ids', async () => {
  const restore = stubFetch(async () => {
    throw new Error('should not fetch');
  });
  try {
    const map = await tw.getLiveStreams([], 'cid', 'secret', 100);
    assert.strictEqual(map.size, 0);
  } finally {
    restore();
  }
});

test('resolveUser returns avatarUrl from profile_image_url', async () => {
  const restore = stubFetch(async url => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      return fakeResponse({ json: { access_token: 'tok', expires_in: 3600 } });
    }
    return fakeResponse({
      json: {
        data: [
          {
            id: '99',
            login: 'streamer',
            display_name: 'Streamer',
            profile_image_url: 'https://cdn.example/avatar.png',
          },
        ],
      },
    });
  });
  try {
    const u = await tw.resolveUser('streamer', 'cid', 'secret');
    assert.strictEqual(u.avatarUrl, 'https://cdn.example/avatar.png');
  } finally {
    restore();
  }
});

test('getUsersByIds batches and maps id -> user info', async () => {
  let userCalls = 0;
  const restore = stubFetch(async url => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      return fakeResponse({ json: { access_token: 'tok', expires_in: 3600 } });
    }
    userCalls++;
    return fakeResponse({
      json: {
        data: [
          { id: '1', login: 'a', display_name: 'A', profile_image_url: 'https://cdn.example/a.png' },
        ],
      },
    });
  });
  try {
    const map = await tw.getUsersByIds(['1', '2', '1'], 'cid', 'secret');
    assert.strictEqual(userCalls, 1, 'deduped into one batched call');
    assert.strictEqual(map.get('1').avatarUrl, 'https://cdn.example/a.png');
    assert.strictEqual(map.has('2'), false);
  } finally {
    restore();
  }
});
