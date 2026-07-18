const { test } = require('node:test');
const assert = require('node:assert');
const ga = require('../systems/guildApproval.js');

function fakeInteraction({ customId, userId, guild = null }) {
  const calls = { update: null, reply: null, left: false };
  return {
    calls,
    isButton: () => true,
    customId,
    user: { id: userId },
    client: {
      guilds: {
        cache: new Map(guild ? [[guild.id, guild]] : []),
      },
    },
    async update(payload) {
      calls.update = payload;
    },
    async reply(payload) {
      calls.reply = payload;
    },
  };
}

function fakeGuild(id, name = 'Test Guild') {
  const g = {
    id,
    name,
    memberCount: 42,
    left: false,
    async leave() {
      g.left = true;
      return g;
    },
  };
  return g;
}

test('parseWlCustomId splits action and guild id', () => {
  assert.deepStrictEqual(ga.parseWlCustomId('wl_approve:123'), {
    action: 'wl_approve',
    guildId: '123',
  });
  assert.deepStrictEqual(ga.parseWlCustomId('wl_deny:456'), {
    action: 'wl_deny',
    guildId: '456',
  });
});

test('approve adds to whitelist and confirms', async () => {
  const added = [];
  ga._setDepsForTests({
    whitelist: { add: id => (added.push(id), true), isAllowed: () => false },
    isOwner: () => true,
  });
  const i = fakeInteraction({ customId: 'wl_approve:111', userId: 'owner' });
  await ga.handleWhitelistInteraction(i);
  assert.deepStrictEqual(added, ['111']);
  assert.match(i.calls.update.content, /approved/i);
  assert.deepStrictEqual(i.calls.update.components, []);
});

test('deny leaves the guild and confirms', async () => {
  ga._setDepsForTests({
    whitelist: { add: () => true, isAllowed: () => false },
    isOwner: () => true,
  });
  const guild = fakeGuild('222');
  const i = fakeInteraction({ customId: 'wl_deny:222', userId: 'owner', guild });
  await ga.handleWhitelistInteraction(i);
  assert.strictEqual(guild.left, true);
  assert.match(i.calls.update.content, /left|denied/i);
});

test('non-owner is rejected without side effects', async () => {
  const added = [];
  ga._setDepsForTests({
    whitelist: { add: id => (added.push(id), true), isAllowed: () => false },
    isOwner: () => false,
  });
  const i = fakeInteraction({ customId: 'wl_approve:333', userId: 'rando' });
  await ga.handleWhitelistInteraction(i);
  assert.deepStrictEqual(added, []);
  assert.strictEqual(i.calls.update, null);
  assert.match(i.calls.reply.content, /not allowed|owner/i);
});

test('stale deny on an already-approved guild does not leave it', async () => {
  ga._setDepsForTests({
    whitelist: { add: () => true, isAllowed: () => true },
    isOwner: () => true,
  });
  const guild = fakeGuild('444');
  const i = fakeInteraction({ customId: 'wl_deny:444', userId: 'owner', guild });
  await ga.handleWhitelistInteraction(i);
  assert.strictEqual(guild.left, false);
  assert.match(i.calls.update.content, /already on the allow-list/i);
});
