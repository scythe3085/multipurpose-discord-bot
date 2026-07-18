const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const net = require('node:net');
const websub = require('../systems/alerts/websub.js');

const ATOM = `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <entry>
    <yt:videoId>vidZ</yt:videoId>
    <yt:channelId>UCzzz</yt:channelId>
    <title>Pushed Video</title>
  </entry>
</feed>`;

function startServer(opts = {}) {
  return websub._createServerForTests({
    secret: opts.secret ?? null,
    onNotification: opts.onNotification ?? (() => {}),
  });
}

test('GET verification echoes hub.challenge', async () => {
  const srv = startServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const res = await fetch(
      `http://127.0.0.1:${port}/websub?hub.mode=subscribe&hub.topic=t&hub.challenge=abc123&hub.lease_seconds=432000`,
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'abc123');
  } finally {
    srv.close();
  }
});

test('POST with valid HMAC triggers onNotification with channel/video ids', async () => {
  const seen = [];
  const srv = startServer({ secret: 'shh', onNotification: n => seen.push(n) });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sig = 'sha1=' + crypto.createHmac('sha1', 'shh').update(ATOM).digest('hex');
    const res = await fetch(`http://127.0.0.1:${port}/websub`, {
      method: 'POST',
      headers: { 'content-type': 'application/atom+xml', 'x-hub-signature': sig },
      body: ATOM,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].channelId, 'UCzzz');
  } finally {
    srv.close();
  }
});

test('POST with bad HMAC is dropped (200 but no processing)', async () => {
  const seen = [];
  const srv = startServer({ secret: 'shh', onNotification: n => seen.push(n) });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/websub`, {
      method: 'POST',
      headers: { 'content-type': 'application/atom+xml', 'x-hub-signature': 'sha1=deadbeef' },
      body: ATOM,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.length, 0);
  } finally {
    srv.close();
  }
});

test('extractChannelIds parses yt:channelId entries', () => {
  assert.deepStrictEqual(websub.extractChannelIds(ATOM), ['UCzzz']);
  assert.deepStrictEqual(websub.extractChannelIds('<feed></feed>'), []);
  assert.deepStrictEqual(websub.extractChannelIds('not xml at all <<<'), []);
});

test('isEnabled only with WEBSUB_CALLBACK_URL set', () => {
  assert.strictEqual(websub.isEnabled({ WEBSUB_CALLBACK_URL: 'https://x.example/websub' }), true);
  assert.strictEqual(websub.isEnabled({}), false);
  assert.strictEqual(websub.isEnabled({ WEBSUB_CALLBACK_URL: '  ' }), false);
});

test('malformed request-target gets 400 and does not crash the server', async () => {
  const srv = startServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.on('data', d => (buf += d.toString()));
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
      const t = setTimeout(() => {
        sock.destroy();
        resolve(buf);
      }, 2000);
      t.unref?.();
    });
    assert.match(raw, /HTTP\/1\.1 400/);
    // The server must still be alive and serving.
    const res = await fetch(`http://127.0.0.1:${port}/websub?hub.challenge=ok`);
    assert.strictEqual(await res.text(), 'ok');
  } finally {
    srv.close();
  }
});
