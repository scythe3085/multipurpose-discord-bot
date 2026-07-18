const { test } = require('node:test');
const assert = require('node:assert');
const { buildYoutubeEmbed, buildTwitchEmbed } = require('../systems/alerts/embeds.js');

test('buildYoutubeEmbed: vod has author link, thumbnail image, duration field', () => {
  const e = buildYoutubeEmbed({
    channelId: 'UCabc',
    channelTitle: 'My Channel',
    avatarUrl: 'https://yt.example/a.jpg',
    videoId: 'vid123',
    title: 'My Video',
    url: 'https://www.youtube.com/watch?v=vid123',
    type: 'vod',
    publishedMs: 1700000000000,
    durationSec: 754,
  }).toJSON();

  assert.strictEqual(e.author.name, 'My Channel');
  assert.strictEqual(e.author.url, 'https://www.youtube.com/channel/UCabc');
  assert.strictEqual(e.author.icon_url, 'https://yt.example/a.jpg');
  assert.strictEqual(e.title, 'My Video');
  assert.strictEqual(e.image.url, 'https://i.ytimg.com/vi/vid123/hqdefault.jpg');
  assert.deepStrictEqual(e.fields, [{ name: 'Duration', value: '12:34', inline: true }]);
  assert.strictEqual(e.footer.text, 'YouTube');
});

test('buildYoutubeEmbed: live has no duration field and a live footer', () => {
  const e = buildYoutubeEmbed({
    channelId: 'UCabc',
    channelTitle: 'C',
    avatarUrl: null,
    videoId: 'v',
    title: 'Live now',
    url: 'https://youtu.be/v',
    type: 'live',
    publishedMs: null,
    durationSec: null,
  }).toJSON();
  assert.strictEqual(e.fields, undefined);
  assert.strictEqual(e.footer.text, 'YouTube · Live now');
  assert.strictEqual(e.author.icon_url, undefined);
});

test('buildTwitchEmbed: author, box art thumbnail, category/viewers/started fields', () => {
  const e = buildTwitchEmbed({
    login: 'streamer',
    displayName: 'Streamer',
    avatarUrl: 'https://cdn.example/a.png',
    stream: {
      id: 's1',
      title: 'Playing games',
      game_id: '509658',
      game_name: 'Just Chatting',
      viewer_count: 1234,
      started_at: '2026-07-18T12:00:00Z',
      thumbnail_url: 'https://cdn.example/prev-{width}x{height}.jpg',
    },
  }).toJSON();

  assert.strictEqual(e.author.name, 'Streamer is LIVE');
  assert.strictEqual(e.author.url, 'https://twitch.tv/streamer');
  assert.strictEqual(e.author.icon_url, 'https://cdn.example/a.png');
  assert.strictEqual(e.title, 'Playing games');
  assert.strictEqual(e.thumbnail.url, 'https://static-cdn.jtvnw.net/ttv-boxart/509658-144x192.jpg');
  assert.ok(e.image.url.startsWith('https://cdn.example/prev-1280x720.jpg?cb='));
  assert.strictEqual(e.fields.length, 3);
  assert.deepStrictEqual(e.fields[0], { name: 'Category', value: 'Just Chatting', inline: true });
  assert.deepStrictEqual(e.fields[1], { name: 'Viewers', value: '1,234', inline: true });
  assert.strictEqual(e.fields[2].name, 'Started');
  assert.match(e.fields[2].value, /^<t:1784376000:R>$/); // Date.parse('2026-07-18T12:00:00Z')/1000
});

test('buildTwitchEmbed: missing thumbnail/game degrade gracefully', () => {
  const e = buildTwitchEmbed({
    login: 'x',
    displayName: null,
    avatarUrl: null,
    stream: { id: 's', title: '', thumbnail_url: '' },
  }).toJSON();
  assert.strictEqual(e.image, undefined);
  assert.strictEqual(e.thumbnail, undefined);
  assert.strictEqual(e.fields, undefined);
  assert.strictEqual(e.author.name, 'x is LIVE');
});
