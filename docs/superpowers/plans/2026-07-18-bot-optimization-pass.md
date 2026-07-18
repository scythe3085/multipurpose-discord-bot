# Bot Optimization Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faster YouTube/Twitch alert detection (channel-deduped conditional polling + optional WebSub push), snappier Discord interactions, painless first-server whitelist onboarding, and a visual upgrade for every embed.

**Architecture:** The alerts poller's per-channel YouTube pipeline is extracted into a shared module used by both the RSS poller and a new opt-in WebSub HTTP endpoint. Whitelist onboarding gains an env seed plus a DM approve/deny flow routed through the existing customId-prefix router (`wl_`). Interaction handlers are reordered so user-visible replies come before best-effort side effects. Embed construction moves into pure builder functions that are unit-testable.

**Tech Stack:** Node.js ≥20 (CommonJS), discord.js v14, better-sqlite3, fast-xml-parser, `node:http`, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-18-bot-optimization-design.md`

**Conventions that apply to every task:**

- Run tests with `node --test` (all) or `node --test test/<file>.test.js` (one file).
- Run `npx eslint .` and `npx prettier --write <changed files>` before each commit.
- Alerts-system files (`systems/alerts/**`, `config/alerts.config.js`) use unicode escapes for emoji (e.g. `🔔`), other files use literal emoji — match whichever the file already does.
- Tests must NEVER call functions that write `config/*.json` (the developer's live gitignored state) — only test pure helpers, or inject fakes via the `_...ForTests` hooks defined below.
- `fetch` stubs in tests often lack `headers`; all new code reading response headers must use `res.headers?.get?.(...)` guards.

---

### Task 1: Whitelist env seed (`ALLOWED_GUILD_IDS`)

**Files:**

- Modify: `systems/whitelist.js` (add `parseSeedIds`, `seedFromEnv` to exports)
- Modify: `index.js:9` (call `seedFromEnv()` after requiring whitelist)
- Modify: `.env.example` (document the variable)
- Test: `test/whitelist.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/whitelist.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseSeedIds } = require('../systems/whitelist.js');

test('parseSeedIds: splits on commas and whitespace, trims, dedupes', () => {
  assert.deepStrictEqual(parseSeedIds('123456789012345, 234567890123456 123456789012345'), [
    '123456789012345',
    '234567890123456',
  ]);
});

test('parseSeedIds: drops non-snowflake garbage', () => {
  assert.deepStrictEqual(parseSeedIds('abc, 12, 123456789012345678, <id>'), ['123456789012345678']);
});

test('parseSeedIds: empty/undefined input gives empty array', () => {
  assert.deepStrictEqual(parseSeedIds(''), []);
  assert.deepStrictEqual(parseSeedIds(undefined), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/whitelist.test.js`
Expected: FAIL — `parseSeedIds is not a function`

- [ ] **Step 3: Implement in `systems/whitelist.js`**

Add above `module.exports`:

```js
/** Parse a comma/whitespace-separated id list into valid snowflake strings. */
function parseSeedIds(raw) {
  return [
    ...new Set(
      String(raw || '')
        .split(/[,\s]+/)
        .map(s => s.trim())
        .filter(s => /^\d{10,25}$/.test(s)),
    ),
  ];
}

/**
 * Merge ALLOWED_GUILD_IDS from the environment into the allow-list, so the
 * first server can be allowed before the bot ever joins it. Runs once at boot.
 */
function seedFromEnv(env = process.env) {
  const seeds = parseSeedIds(env.ALLOWED_GUILD_IDS);
  let added = 0;
  for (const id of seeds) {
    if (add(id)) added++;
  }
  if (added) {
    console.log(`✅ Whitelist: seeded ${added} guild id(s) from ALLOWED_GUILD_IDS.`);
  }
  return added;
}
```

Change the export line to:

```js
module.exports = { list, isAllowed, add, remove, reload, parseSeedIds, seedFromEnv };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/whitelist.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into `index.js`**

Directly under `const whitelist = require('./systems/whitelist.js');` (line 9) add:

```js
// Pre-seed the allow-list from .env so the first server can be allowed before
// the bot ever joins it (no chicken-and-egg with the /add slash command).
whitelist.seedFromEnv();
```

- [ ] **Step 6: Document in `.env.example`**

Append to the owner section (after `OWNER_ID=`):

```
# Optional: comma-separated guild IDs to pre-allow at startup. Solves the
# first-server chicken-and-egg: /add only works inside a server the bot is
# already in. Example: ALLOWED_GUILD_IDS=123456789012345678,234567890123456789
ALLOWED_GUILD_IDS=
```

- [ ] **Step 7: Full test run + lint, then commit**

Run: `node --test` then `npx eslint .`
Expected: all tests pass, no lint errors

```bash
git add systems/whitelist.js index.js .env.example test/whitelist.test.js
git commit -m "feat: seed guild whitelist from ALLOWED_GUILD_IDS env var"
```

---

### Task 2: DM approval flow for non-whitelisted guilds

**Files:**

- Create: `systems/guildApproval.js`
- Modify: `index.js` (replace `guildCreate` handler; add `wl_` route; add ready-sweep)
- Test: `test/guildApproval.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/guildApproval.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/guildApproval.test.js`
Expected: FAIL — `Cannot find module '../systems/guildApproval.js'`

- [ ] **Step 3: Create `systems/guildApproval.js`**

```js
// systems/guildApproval.js
// First-run friendly whitelist onboarding. Instead of insta-leaving a
// non-whitelisted guild, DM the bot owner an approval card with Approve/Leave
// buttons (customId prefix wl_, routed by index.js). A startup sweep re-checks
// every current guild, so restarts and missed DMs self-heal. Pending state is
// in-memory only — the sweep is the source of truth.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Injectable for tests (never write the real allow-list from a test).
let deps = {
  whitelist: require('./whitelist.js'),
  isOwner: require('./permissions.js').isOwner,
  getOwnerId: require('./permissions.js').getOwnerId,
};

function _setDepsForTests(overrides) {
  deps = { ...deps, ...overrides };
}

const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000; // auto-leave after 24h unapproved
const pendingTimers = new Map(); // guildId -> Timeout

function parseWlCustomId(customId) {
  const [action, guildId] = String(customId || '').split(':');
  return { action, guildId };
}

function buildApprovalEmbed(guild) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('🛡️ New server wants the bot')
    .setDescription(
      `The bot was added to a server that is not on the allow-list.\n` +
        `Approve to whitelist it, or Leave to reject. If you do nothing, the bot ` +
        `leaves automatically in **24 hours**.`,
    )
    .addFields(
      { name: 'Server', value: `${guild.name}`, inline: true },
      { name: 'Server ID', value: `\`${guild.id}\``, inline: true },
      { name: 'Members', value: `${guild.memberCount ?? '?'}`, inline: true },
    )
    .setTimestamp();
}

function buildApprovalRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wl_approve:${guildId}`)
      .setLabel('✅ Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`wl_deny:${guildId}`)
      .setLabel('🚪 Leave')
      .setStyle(ButtonStyle.Danger),
  );
}

function clearPending(guildId) {
  const t = pendingTimers.get(guildId);
  if (t) clearTimeout(t);
  pendingTimers.delete(guildId);
}

/**
 * Ask the owner (via DM) whether this guild may use the bot. Falls back to the
 * old leave-immediately behaviour when the DM cannot be delivered.
 */
async function requestApproval(client, guild) {
  if (deps.whitelist.isAllowed(guild.id)) return;
  if (pendingTimers.has(guild.id)) return; // already asked, waiting on the owner

  const ownerId = deps.getOwnerId();
  if (!ownerId) {
    console.log(
      `⚠️ Joined unauthorized guild ${guild.name} (${guild.id}) and OWNER_ID is unset — leaving. ` +
        `Tip: set ALLOWED_GUILD_IDS in .env to pre-allow your server.`,
    );
    await guild.leave().catch(err => console.error('⚠️ Failed to leave guild:', err));
    return;
  }

  try {
    const owner = await client.users.fetch(ownerId);
    await owner.send({
      embeds: [buildApprovalEmbed(guild)],
      components: [buildApprovalRow(guild.id)],
    });
  } catch (err) {
    console.log(
      `⚠️ Could not DM the owner to approve ${guild.name} (${guild.id}) — leaving. ` +
        `(${err.message}) Tip: set ALLOWED_GUILD_IDS in .env to pre-allow your server.`,
    );
    await guild.leave().catch(e => console.error('⚠️ Failed to leave guild:', e));
    return;
  }

  console.log(`📨 Sent whitelist approval DM for ${guild.name} (${guild.id}).`);
  const timer = setTimeout(() => {
    pendingTimers.delete(guild.id);
    const g = client.guilds.cache.get(guild.id);
    if (g && !deps.whitelist.isAllowed(g.id)) {
      console.log(`⏳ Approval window expired for ${g.name} (${g.id}) — leaving.`);
      g.leave().catch(err => console.error('⚠️ Failed to leave expired guild:', err));
    }
  }, PENDING_TIMEOUT_MS);
  // Don't let a pending approval hold the process open on shutdown.
  timer.unref?.();
  pendingTimers.set(guild.id, timer);
}

/** Re-check every current guild — covers joins that happened while offline. */
async function sweepUnapproved(client) {
  for (const guild of client.guilds.cache.values()) {
    if (!deps.whitelist.isAllowed(guild.id)) {
      await requestApproval(client, guild);
    }
  }
}

/** Router target for wl_approve:<id> / wl_deny:<id> DM buttons. */
async function handleWhitelistInteraction(interaction) {
  if (!interaction.isButton()) return;
  const { action, guildId } = parseWlCustomId(interaction.customId);
  if (!guildId) return;

  if (!deps.isOwner(interaction.user.id)) {
    return interaction.reply({ content: '🚫 Only the bot owner can do this.' });
  }

  clearPending(guildId);
  const guild = interaction.client.guilds.cache.get(guildId);
  const label = guild ? `**${guild.name}**` : `\`${guildId}\``;

  if (action === 'wl_approve') {
    deps.whitelist.add(guildId);
    return interaction.update({
      content:
        `✅ Approved ${label} — it is now on the allow-list.` +
        (guild ? '' : '\nℹ️ The bot is not currently in that server; re-invite it.'),
      embeds: [],
      components: [],
    });
  }

  if (action === 'wl_deny') {
    if (guild) {
      await guild.leave().catch(err => console.error('⚠️ Failed to leave denied guild:', err));
    }
    return interaction.update({
      content: `🚪 Denied ${label} — the bot has left.`,
      embeds: [],
      components: [],
    });
  }
}

module.exports = {
  requestApproval,
  sweepUnapproved,
  handleWhitelistInteraction,
  parseWlCustomId,
  _setDepsForTests,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/guildApproval.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into `index.js`**

Add the require near the other system handlers (after line 14):

```js
const guildApproval = require('./systems/guildApproval.js');
```

Replace the whole `guildCreate` block (lines 68–81, `// ====== GUILD WHITELIST PROTECTION ======` through its closing `});`) with:

```js
// ====== GUILD WHITELIST PROTECTION ======
// Non-whitelisted joins now DM the owner an Approve/Leave card instead of
// insta-leaving; see systems/guildApproval.js.
client.on('guildCreate', guild => {
  if (whitelist.isAllowed(guild.id)) {
    console.log(`✅ Joined allowed guild: ${guild.name} (${guild.id})`);
  } else {
    guildApproval
      .requestApproval(client, guild)
      .catch(err => console.error('⚠️ Guild approval flow failed:', err));
  }
});
```

Add a `wl_` route as the FIRST entry of `componentRoutes` (line 90):

```js
const componentRoutes = [
  { match: id => id.startsWith('wl_'), handle: guildApproval.handleWhitelistInteraction },
  { match: id => id.startsWith('alerts_roles:'), handle: handleAlertsInteraction },
  { match: id => id.startsWith('ticket_'), handle: handleTicketComponentOrModal },
  { match: id => id.startsWith('vc_'), handle: handleVcInteraction },
  { match: id => id.startsWith('verify_'), handle: handleVerifyInteraction },
];
```

In the `ClientReady` handler, after the alerts init `try/catch`, add:

```js
// Sweep guilds that joined while the bot was offline (or missed a DM).
guildApproval.sweepUnapproved(c).catch(err => console.error('⚠️ Whitelist sweep failed:', err));
```

- [ ] **Step 6: Full test run + lint, then commit**

Run: `node --test` then `npx eslint .`
Expected: all pass

```bash
git add systems/guildApproval.js index.js test/guildApproval.test.js
git commit -m "feat: DM approval flow for non-whitelisted guild joins"
```

---

### Task 3: avatarUrl column + provider avatar lookups

**Files:**

- Modify: `systems/alerts/db.js` (new `ensureColumn` call)
- Modify: `systems/alerts/queries.js` (insert gains avatarUrl; two new helpers)
- Modify: `systems/alerts/providers/twitch.js` (`resolveUser` returns avatar; new `getUsersByIds`)
- Modify: `systems/alerts/providers/youtube.js` (new `fetchChannelAvatar`)
- Modify: `systems/alerts/alerts.js` (store avatarUrl on add, both providers)
- Test: `test/twitch.test.js`, `test/youtube.test.js` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `test/twitch.test.js`:

```js
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
          {
            id: '1',
            login: 'a',
            display_name: 'A',
            profile_image_url: 'https://cdn.example/a.png',
          },
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
```

Append to `test/youtube.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/twitch.test.js test/youtube.test.js`
Expected: FAIL — `avatarUrl` undefined, `getUsersByIds`/`fetchChannelAvatar` not functions

- [ ] **Step 3: Implement provider changes**

`systems/alerts/providers/twitch.js` — change `resolveUser`'s return to:

```js
return {
  id: u.id,
  name: u.display_name || u.login,
  login: u.login,
  avatarUrl: u.profile_image_url || null,
};
```

Add below `getLiveStreams` (and export it):

```js
/**
 * Batch-fetch user profiles for many broadcaster ids.
 * Returns Map<user_id, { name, login, avatarUrl }>.
 */
async function getUsersByIds(userIds, clientId, clientSecret, batchSize = 100) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const map = new Map();
  if (!ids.length) return map;

  const token = await getAppToken(clientId, clientSecret);
  for (const group of chunk(ids, batchSize)) {
    const qs = group.map(id => `id=${encodeURIComponent(id)}`).join('&');
    try {
      const json = await twitchApiGet(`users?${qs}`, clientId, token);
      for (const u of json?.data || []) {
        map.set(String(u.id), {
          name: u.display_name || u.login,
          login: u.login,
          avatarUrl: u.profile_image_url || null,
        });
      }
    } catch (err) {
      console.error('Twitch users batch failed:', err.message);
    }
  }
  return map;
}
```

Update the module.exports to include `getUsersByIds`.

`systems/alerts/providers/youtube.js` — add before `module.exports` (and export it):

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/twitch.test.js test/youtube.test.js`
Expected: PASS

- [ ] **Step 5: DB migration + queries**

`systems/alerts/db.js` — after the `lastLiveAlertAt` migration add:

```js
// avatarUrl: source channel/streamer avatar for the alert embed author icon.
// Filled at subscribe time; Twitch rows are refreshed daily by the poller.
ensureColumn('subscriptions', 'avatarUrl', `ALTER TABLE subscriptions ADD COLUMN avatarUrl TEXT`);
```

`systems/alerts/queries.js` — in `insertSubscription`, add `avatarUrl` to both the column list and VALUES list:

```js
    INSERT INTO subscriptions
    (id, guildId, provider, sourceId, sourceLabel, sourceLogin, types, discordChannelId, mentionRoleIds, enabled, createdBy, createdAt, customTemplate, avatarUrl)
    VALUES
    (@id, @guildId, @provider, @sourceId, @sourceLabel, @sourceLogin, @types, @discordChannelId, @mentionRoleIds, @enabled, @createdBy, @createdAt, @customTemplate, @avatarUrl)
```

Add two helpers (and export them):

```js
function getDistinctSourceIds(provider) {
  return db
    .prepare(`SELECT DISTINCT sourceId FROM subscriptions WHERE provider=? AND enabled=1`)
    .all(provider)
    .map(r => r.sourceId);
}

function setAvatarForSource(provider, sourceId, url) {
  db.prepare(`UPDATE subscriptions SET avatarUrl=? WHERE provider=? AND sourceId=?`).run(
    url,
    provider,
    sourceId,
  );
}
```

- [ ] **Step 6: Store avatars on `/alerts add`**

`systems/alerts/alerts.js`, YouTube branch — after `const label = resolved.label || channelId;` add:

```js
const avatarUrl = await yt.fetchChannelAvatar(channelId, youtubeApiKey);
```

and add `avatarUrl,` to the `q.insertSubscription({...})` object (after `customTemplate: null,`).

Twitch branch — add `avatarUrl: u.avatarUrl || null,` to its `q.insertSubscription({...})` object.

- [ ] **Step 7: Full test run + lint, then commit**

Run: `node --test` then `npx eslint .`
Expected: all pass

```bash
git add systems/alerts/db.js systems/alerts/queries.js systems/alerts/providers/twitch.js systems/alerts/providers/youtube.js systems/alerts/alerts.js test/twitch.test.js test/youtube.test.js
git commit -m "feat: store source avatars for alert embeds (avatarUrl column)"
```

---

### Task 4: Alert embed builders (`systems/alerts/embeds.js`)

**Files:**

- Create: `systems/alerts/embeds.js`
- Test: `test/embeds.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/embeds.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/embeds.test.js`
Expected: FAIL — `Cannot find module '../systems/alerts/embeds.js'`

- [ ] **Step 3: Create `systems/alerts/embeds.js`**

```js
// systems/alerts/embeds.js
// Pure embed builders for alert posts. No Discord client, no DB — everything
// arrives as arguments so these are trivially unit-testable.

const { EmbedBuilder } = require('discord.js');
const cfg = require('../../config/alerts.config.js');

function trunc(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// 754 -> "12:34", 3754 -> "1:02:34"
function formatClock(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function buildYoutubeEmbed({
  channelId,
  channelTitle,
  avatarUrl,
  videoId,
  title,
  url,
  type,
  publishedMs,
  durationSec,
}) {
  const embed = new EmbedBuilder()
    .setColor(cfg.COLORS.youtube[type] ?? cfg.COLORS.youtube.vod)
    .setAuthor({
      name: trunc(channelTitle || 'YouTube', 256),
      url: channelId
        ? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`
        : undefined,
      iconURL: avatarUrl || undefined,
    })
    .setTitle(trunc(title || 'New upload', 256))
    .setURL(url)
    .setImage(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`)
    .setFooter({
      text:
        type === 'live' ? 'YouTube · Live now' : type === 'shorts' ? 'YouTube Shorts' : 'YouTube',
    })
    .setTimestamp(publishedMs ? new Date(publishedMs) : new Date());

  if (type === 'vod' && typeof durationSec === 'number' && durationSec > 0) {
    embed.addFields({ name: 'Duration', value: formatClock(durationSec), inline: true });
  }
  return embed;
}

function buildTwitchEmbed({ login, displayName, avatarUrl, stream }) {
  const url = `https://twitch.tv/${encodeURIComponent(login)}`;
  const embed = new EmbedBuilder()
    .setColor(cfg.COLORS.twitch?.live ?? 0x9146ff)
    .setAuthor({
      name: trunc(`${displayName || login} is LIVE`, 256),
      url,
      iconURL: avatarUrl || undefined,
    })
    .setTitle(trunc(stream.title || '🔴 Live on Twitch', 256))
    .setURL(url);

  // Helix occasionally omits thumbnail_url right at go-live; "?cb=" busts the
  // CDN cache so the preview isn't a stale offline frame.
  const thumbBase = String(stream.thumbnail_url || '');
  if (thumbBase) {
    embed.setImage(
      thumbBase.replace('{width}', '1280').replace('{height}', '720') + `?cb=${Date.now()}`,
    );
  }
  if (stream.game_id) {
    embed.setThumbnail(
      `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(stream.game_id)}-144x192.jpg`,
    );
  }
  if (stream.game_name) {
    embed.addFields({ name: 'Category', value: trunc(stream.game_name, 1024), inline: true });
  }
  if (typeof stream.viewer_count === 'number') {
    embed.addFields({
      name: 'Viewers',
      value: stream.viewer_count.toLocaleString('en-US'),
      inline: true,
    });
  }
  const startedMs = stream.started_at ? Date.parse(stream.started_at) : NaN;
  if (!Number.isNaN(startedMs)) {
    embed.addFields({
      name: 'Started',
      value: `<t:${Math.floor(startedMs / 1000)}:R>`,
      inline: true,
    });
    embed.setTimestamp(new Date(startedMs));
  } else {
    embed.setTimestamp();
  }
  return embed;
}

module.exports = { buildYoutubeEmbed, buildTwitchEmbed };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/embeds.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add systems/alerts/embeds.js test/embeds.test.js
git commit -m "feat: pure embed builders for YouTube/Twitch alerts"
```

---

### Task 5: Conditional GET (ETag) support in the YouTube feed fetch

**Files:**

- Modify: `systems/alerts/providers/youtube.js` (`fetchRssTextWithRetry`, `fetchYoutubeFeed`, `classifyVideo` return gains `durationSec`)
- Test: `test/youtube.test.js` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `test/youtube.test.js` (note: these fakes need a `headers.get`):

```js
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
      u => {
        sentHeader = globalThis.__lastFetchOptions?.headers?.['If-None-Match'] ?? null;
        return fakeXmlResponse({ status: 304 });
      },
    ],
  ]);
  // capture options: wrap the stub to record the second fetch arg
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/youtube.test.js`
Expected: FAIL — `cacheEntry`/`notModified`/`durationSec` undefined

- [ ] **Step 3: Implement conditional fetch in `youtube.js`**

Replace `fetchRssTextWithRetry` with a version that accepts a cache entry and returns `{ text, cacheEntry }` or `{ notModified: true }`:

```js
/**
 * Fetch RSS XML with retries + browser-like headers, using conditional
 * requests when a prior { etag, lastModified } cache entry is supplied.
 * Returns { text, cacheEntry } on 200 or { notModified: true } on 304.
 */
async function fetchRssTextWithRetry(url, cacheEntry = null) {
  const tries = 3;
  const timeoutMs = 15000;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      };
      if (cacheEntry?.etag) headers['If-None-Match'] = cacheEntry.etag;
      if (cacheEntry?.lastModified) headers['If-Modified-Since'] = cacheEntry.lastModified;

      const res = await fetch(url, { signal: controller.signal, headers });
      clearTimeout(t);

      if (res.status === 304) return { notModified: true };

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

      return {
        text: await res.text(),
        cacheEntry: {
          etag: res.headers?.get?.('etag') ?? null,
          lastModified: res.headers?.get?.('last-modified') ?? null,
        },
      };
    } catch (err) {
      clearTimeout(t);
      if (attempt >= tries) throw err;
      await new Promise(r => setTimeout(r, 750 * attempt));
    }
  }

  throw new Error('YouTube RSS fetch failed');
}
```

Update `fetchYoutubeFeed` to take/pass the cache entry and propagate `notModified`/`cacheEntry`:

```js
async function fetchYoutubeFeed(channelId, cacheEntry = null) {
  const id = (channelId || '').trim();

  // Try both hosts (some networks behave differently)
  const urls = [
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`,
    `https://youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`,
  ];

  let result = null;
  let lastErr = null;

  for (const url of urls) {
    try {
      result = await fetchRssTextWithRetry(url, cacheEntry);
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!result) throw lastErr || new Error('YouTube RSS fetch failed');
  if (result.notModified) return { notModified: true };

  const data = parser.parse(result.text);
  // ... keep the existing parsing body exactly as-is (feed/entries/items) ...
  return { channelTitle, items, cacheEntry: result.cacheEntry };
}
```

(Keep the existing `entries`/`channelTitle`/`items` block between `parser.parse` and the return.)

- [ ] **Step 4: Add `durationSec` to `classifyVideo` returns**

In `classifyVideo`, change every return that has a computed duration to include it:

- `if (liveBroadcastContent === 'upcoming') return { type: 'upcoming', title };` → unchanged (no duration relevance)
- `if (isLiveNow) return { type: 'live', title };` → unchanged
- `return { type: 'vod', title };` (the `> SHORTS_MAX_DURATION` branch) → `return { type: 'vod', title, durationSec };`
- `if (isShort === true) return { type: 'shorts', title };` → `return { type: 'shorts', title, durationSec };`
- `if (isShort === false) return { type: 'vod', title };` → `return { type: 'vod', title, durationSec };`
- the final `<=60`/fallback returns → add `durationSec` the same way.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/youtube.test.js`
Expected: PASS (all previous + 3 new)

- [ ] **Step 6: Full test run + lint, then commit**

```bash
git add systems/alerts/providers/youtube.js test/youtube.test.js
git commit -m "feat: conditional-GET feed fetch and durationSec classification"
```

---

### Task 6: Shared YouTube pipeline + channel-deduped poller

**Files:**

- Create: `systems/alerts/youtubePipeline.js`
- Modify: `systems/alerts/poller.js` (delete `processYoutubeSub`; group by channel; export `postAlert`)
- Modify: `config/alerts.config.js` (`YOUTUBE_POLL_MS` 60s, add `YOUTUBE_POLL_MS_WEBSUB`)
- Test: `test/youtubePipeline.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/youtubePipeline.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/youtubePipeline.test.js`
Expected: FAIL — `Cannot find module '../systems/alerts/youtubePipeline.js'`

- [ ] **Step 3: Create `systems/alerts/youtubePipeline.js`**

```js
// systems/alerts/youtubePipeline.js
// Shared per-channel YouTube pipeline: fetch a channel's feed ONCE, classify
// each new video ONCE, then fan out per subscription (seen-tracking, type
// filter, claim-before-post). Used by both the RSS poller and the WebSub push
// handler. Dependencies are injectable for tests; production callers rely on
// the defaults.

const cfg = require('../../config/alerts.config.js');
const defaultQueries = require('./queries.js');
const defaultProvider = require('./providers/youtube.js');
const { safeJsonParse, formatTemplate, displayType } = require('./utils.js');
const { buildYoutubeEmbed } = require('./embeds.js');

// channelId -> { etag, lastModified } conditional-request cache. In-memory
// only: a restart just refetches once.
const feedCache = new Map();

function _clearFeedCacheForTests() {
  feedCache.clear();
}

/** Drop the cache entry so the next fetch is unconditional (used on WebSub push). */
function bustFeedCache(channelId) {
  feedCache.delete(channelId);
}

/**
 * Process one YouTube channel for all of its subscriptions.
 * ctx: {
 *   channelId, subs, youtubeApiKey,
 *   state: { posted, quotaHit },   // shared across the whole cycle
 *   postAlert(sub, text, roleIds, embed),
 *   queries?, provider?,           // injectable for tests
 * }
 */
async function processYoutubeChannel(ctx) {
  const {
    channelId,
    subs,
    youtubeApiKey,
    state,
    postAlert,
    queries = defaultQueries,
    provider = defaultProvider,
  } = ctx;

  let feed;
  try {
    feed = await provider.fetchYoutubeFeed(channelId, feedCache.get(channelId));
  } catch (err) {
    console.error('[alerts] YouTube feed error:', channelId, err.message);
    return;
  }
  if (feed.notModified) return;
  if (feed.cacheEntry) feedCache.set(channelId, feed.cacheEntry);

  const { channelTitle, items } = feed;
  // videoId -> classified, per channel per cycle: N subs cost 1 classification.
  const classifyCache = new Map();

  for (const item of items) {
    // Quota is global to the API key — once any channel trips it, stop
    // classifying everywhere rather than burning more calls that will fail.
    if (state.quotaHit) break;
    try {
      const publishedMs = item.published ? Date.parse(item.published) : null;

      // Work out which subs still need this item BEFORE classifying, so a
      // fully-seen or pre-subscription item costs zero Data API calls.
      const pending = [];
      for (const sub of subs) {
        if (queries.hasSeen(sub.id, item.videoId)) continue;
        // Ignore videos published before the subscription was created.
        if (publishedMs && publishedMs <= sub.createdAt) {
          queries.markSeen(sub.id, item.videoId);
          continue;
        }
        pending.push(sub);
      }
      if (!pending.length) continue;

      let classified = classifyCache.get(item.videoId);
      if (!classified) {
        classified = await provider.classifyVideo(item.videoId, youtubeApiKey);
        if (!classified.error) classifyCache.set(item.videoId, classified);
      }

      // Classification failed (quota/5xx/network). Do NOT mark seen — retry
      // next cycle.
      if (classified.error) {
        if (/\b403\b/.test(classified.error)) state.quotaHit = true;
        console.error('[alerts] YouTube classify failed:', item.videoId, classified.error);
        if (state.quotaHit) break;
        continue;
      }

      // Scheduled premiere / not-yet-started stream: skip WITHOUT marking
      // seen so it fires when it actually flips to live.
      if (classified.type === 'upcoming') continue;

      const type = classified.type || 'vod';
      const title = classified.title || item.title || 'New upload';

      for (const sub of pending) {
        const types = safeJsonParse(sub.types, []);
        if (!types.includes(type)) {
          queries.markSeen(sub.id, item.videoId);
          continue;
        }

        // Claim BEFORE posting so a race can't double-send.
        if (!queries.markSeen(sub.id, item.videoId)) continue;

        const template =
          (sub.customTemplate && String(sub.customTemplate).trim().length
            ? sub.customTemplate
            : null) ||
          cfg.TEMPLATES.youtube[type] ||
          cfg.TEMPLATES.youtube.vod;

        const text = formatTemplate(template, {
          name: channelTitle,
          channel: channelTitle, // legacy support
          title,
          url: item.link,
          type: displayType(type),
        });

        const roleIds = safeJsonParse(sub.mentionRoleIds, []);
        const embed = buildYoutubeEmbed({
          channelId,
          channelTitle,
          avatarUrl: sub.avatarUrl,
          videoId: item.videoId,
          title,
          url: item.link,
          type,
          publishedMs,
          durationSec: classified.durationSec ?? null,
        });

        await postAlert(sub, text, roleIds, embed);
        state.posted++;
      }
    } catch (err) {
      // One item must never abort the rest of the channel/cycle.
      console.error('[alerts] YouTube item error:', channelId, item.videoId, err.message);
    }
  }
}

module.exports = { processYoutubeChannel, bustFeedCache, _clearFeedCacheForTests };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/youtubePipeline.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Rewire `systems/alerts/poller.js`**

- Delete the whole `processYoutubeSub` function (lines 57–151) and the `EmbedBuilder` import if now unused by `pollYoutube` (it is still used by `pollTwitch` until Task 7 — keep it for now).
- Add near the top: `const { processYoutubeChannel } = require('./youtubePipeline.js');`
- Replace `pollYoutube` with:

```js
async function pollYoutube() {
  if (youtubeRunning) return; // re-entrancy guard: a slow cycle must not overlap
  youtubeRunning = true;
  const youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
  const subs = q.getSubsForProvider('youtube');

  // Group by channel so N subs to the same channel cost ONE feed fetch and
  // ONE classification per new video.
  const byChannel = new Map();
  for (const sub of subs) {
    const list = byChannel.get(sub.sourceId) || [];
    list.push(sub);
    byChannel.set(sub.sourceId, list);
  }

  // Shared across the concurrent channel-workers below.
  const state = { posted: 0, quotaHit: false };

  try {
    await mapWithConcurrency(
      [...byChannel.entries()],
      cfg.YOUTUBE_POLL_CONCURRENCY,
      async ([channelId, channelSubs]) => {
        if (state.quotaHit) return;
        await processYoutubeChannel({
          channelId,
          subs: channelSubs,
          youtubeApiKey,
          state,
          postAlert,
        });
      },
    );
  } finally {
    youtubeRunning = false;
  }

  if (state.posted || state.quotaHit) {
    console.log(
      `[alerts] youtube poll: ${subs.length} subs / ${byChannel.size} channels, ${state.posted} posted${state.quotaHit ? ' (Data API quota exhausted — backing off)' : ''}`,
    );
  }
}
```

- Export `postAlert` (WebSub will need it in Task 8): add `postAlert,` to `module.exports`.
- Remove now-unused imports from the destructured `utils.js` require in poller.js if eslint flags them (keep `safeJsonParse`, `uniq`, `clampArray`, `formatTemplate`, `displayType`, `mapWithConcurrency` — Twitch still uses most; delete only what eslint reports unused).

- [ ] **Step 6: Update `config/alerts.config.js` intervals**

```js
  // Poll intervals (ms)
  YOUTUBE_POLL_MS: 60 * 1000, // 1 min (channel-deduped + conditional GETs keep this cheap)
  // Fallback interval when WebSub push is active — polling stays on only as a
  // safety net, so it can be much lazier.
  YOUTUBE_POLL_MS_WEBSUB: 5 * 60 * 1000, // 5 min
```

(Keep `TWITCH_POLL_MS` as is.)

- [ ] **Step 7: Full test run + lint, then commit**

Run: `node --test` then `npx eslint .`
Expected: all pass; `node -e "require('./systems/alerts/poller.js')"` loads without error.

```bash
git add systems/alerts/youtubePipeline.js systems/alerts/poller.js config/alerts.config.js test/youtubePipeline.test.js
git commit -m "feat: channel-deduped YouTube polling via shared pipeline, 60s interval"
```

---

### Task 7: Twitch hardening (429 retry, daily avatar refresh, new embed)

**Files:**

- Modify: `systems/alerts/providers/twitch.js` (`twitchApiGet` 429 handling)
- Modify: `systems/alerts/poller.js` (`pollTwitch` uses `buildTwitchEmbed`; avatar refresh timer)
- Modify: `config/alerts.config.js` (`TWITCH_AVATAR_REFRESH_MS`)
- Test: `test/twitch.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/twitch.test.js`:

```js
test('twitchApiGet retries once on 429 honoring ratelimit-reset', async () => {
  let streamCalls = 0;
  const restore = stubFetch(async url => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      return fakeResponse({ json: { access_token: 'tok', expires_in: 3600 } });
    }
    streamCalls++;
    if (streamCalls === 1) {
      return {
        status: 429,
        ok: false,
        headers: {
          get: n =>
            String(n).toLowerCase() === 'ratelimit-reset'
              ? String(Math.ceil(Date.now() / 1000))
              : null,
        },
        async json() {
          return {};
        },
      };
    }
    return fakeResponse({ json: { data: [{ id: 's1', user_id: '1', title: 'A' }] } });
  });
  try {
    const map = await tw.getLiveStreams(['1'], 'cid', 'secret', 100);
    assert.strictEqual(streamCalls, 2, '429 then retried');
    assert.strictEqual(map.get('1').id, 's1');
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/twitch.test.js`
Expected: FAIL — current code throws `Twitch API failed: 429` (batch isolated → empty map, `map.get('1')` undefined)

- [ ] **Step 3: Implement 429 retry in `twitchApiGet`**

Replace `twitchApiGet` in `systems/alerts/providers/twitch.js`:

```js
async function twitchApiGet(path, clientId, token, { retryOn429 = true } = {}) {
  const res = await fetchWithTimeout(`https://api.twitch.tv/helix/${path}`, {
    headers: {
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  // Helix rate limit: wait until the bucket resets (header is epoch seconds),
  // then retry ONCE. Waits are capped so a bad header can't stall a cycle.
  if (res.status === 429 && retryOn429) {
    const resetSec = Number(res.headers?.get?.('ratelimit-reset')) || 0;
    const waitMs = Math.min(Math.max(resetSec * 1000 - Date.now(), 250), 5000);
    await new Promise(r => setTimeout(r, waitMs));
    return twitchApiGet(path, clientId, token, { retryOn429: false });
  }
  if (!res.ok) {
    const err = new Error(`Twitch API failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/twitch.test.js`
Expected: PASS

- [ ] **Step 5: New embed + avatar refresh in `poller.js`**

Add imports at the top of `systems/alerts/poller.js`:

```js
const { buildTwitchEmbed } = require('./embeds.js');
```

In `pollTwitch`, replace the embed construction block — everything from `const embed = new EmbedBuilder()` through the `viewer_count` `addFields` block (poller.js lines 247–278 pre-task) — with:

```js
const embed = buildTwitchEmbed({
  login: loginSlug,
  displayName: sub.sourceLabel,
  avatarUrl: sub.avatarUrl,
  stream,
});
```

(The `loginSlug`, `url`, `template`, and `text` lines above it stay. Delete the now-unused `EmbedBuilder` import from poller.js.)

Add the avatar refresh function after `pollTwitch`:

```js
// Refresh stored Twitch avatars daily (one batched users call per 100 ids) so
// embed author icons don't go stale when streamers change their pfp.
async function refreshTwitchAvatars() {
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return;

  const ids = q.getDistinctSourceIds('twitch');
  if (!ids.length) return;

  try {
    const users = await tw.getUsersByIds(ids, clientId, clientSecret);
    for (const [id, u] of users) {
      q.setAvatarForSource('twitch', id, u.avatarUrl || null);
    }
  } catch (err) {
    console.error('[alerts] Twitch avatar refresh failed:', err.message);
  }
}
```

In `startPollers`, add a timer alongside the others:

```js
let avatarTimer = null;
```

(top of file, next to the other timer lets), and inside `startPollers`:

```js
if (avatarTimer) clearInterval(avatarTimer);
avatarTimer = setInterval(
  () => refreshTwitchAvatars().catch(() => {}),
  cfg.TWITCH_AVATAR_REFRESH_MS,
);
refreshTwitchAvatars().catch(() => {});
```

- [ ] **Step 6: Add config value**

In `config/alerts.config.js`, after `TWITCH_RELIVE_COOLDOWN_MS`:

```js
  // Refresh stored Twitch profile avatars this often (daily).
  TWITCH_AVATAR_REFRESH_MS: 24 * 60 * 60 * 1000,
```

- [ ] **Step 7: Full test run + lint, then commit**

```bash
git add systems/alerts/providers/twitch.js systems/alerts/poller.js config/alerts.config.js test/twitch.test.js
git commit -m "feat: twitch 429 retry, richer live embed, daily avatar refresh"
```

---

### Task 8: WebSub push endpoint (opt-in)

**Files:**

- Create: `systems/alerts/websub.js`
- Modify: `systems/alerts/alerts.js` (init + subscribe on add / unsubscribe on remove)
- Modify: `systems/alerts/poller.js` (`startPollers` picks the WebSub fallback interval)
- Modify: `systems/alerts/queries.js` (add `getSubsForSource`)
- Modify: `config/alerts.config.js` (WEBSUB block)
- Modify: `.env.example`
- Test: `test/websub.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/websub.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/websub.test.js`
Expected: FAIL — `Cannot find module '../systems/alerts/websub.js'`

- [ ] **Step 3: Add `getSubsForSource` to `systems/alerts/queries.js`** (and export it)

```js
function getSubsForSource(provider, sourceId) {
  return db
    .prepare(`SELECT * FROM subscriptions WHERE provider=? AND sourceId=? AND enabled=1`)
    .all(provider, sourceId);
}
```

- [ ] **Step 4: Create `systems/alerts/websub.js`**

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/websub.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Config + wiring**

`config/alerts.config.js` — add:

```js
  // WebSub (YouTube push). Only active when WEBSUB_CALLBACK_URL is set in .env.
  WEBSUB: {
    HUB_URL: 'https://pubsubhubbub.appspot.com/',
    LEASE_SECONDS: 828000, // hub max (~9.6 days)
    RENEW_CHECK_MS: 60 * 60 * 1000, // hourly expiry check
    RENEW_MARGIN_MS: 24 * 60 * 60 * 1000, // renew when <24h of lease left
  },
```

`systems/alerts/poller.js` — in `startPollers`, pick the interval based on push mode. Add `const websub = require('./websub.js');` at the top, then:

```js
const youtubePollMs = websub.isEnabled() ? cfg.YOUTUBE_POLL_MS_WEBSUB : cfg.YOUTUBE_POLL_MS;
youtubeTimer = setInterval(() => pollYoutube().catch(() => {}), youtubePollMs);
```

`systems/alerts/alerts.js`:

- Add `const websub = require('./websub.js');` near the other requires.
- In `initAlertsSystem`, after `poller.startPollers();` add:

```js
websub.init(poller.postAlert); // no-op unless WEBSUB_CALLBACK_URL is set
```

- In `alertsAdd`'s YouTube branch, right after `q.insertSubscription({...})`, add:

```js
websub.subscribeChannel(channelId);
```

- In `alertsRemove`, after `q.deleteSubscription(id, interaction.guildId);` add:

```js
if (row.provider === 'youtube') websub.unsubscribeChannel(row.sourceId);
```

`.env.example` — append a new section:

```
# ── Optional: YouTube WebSub push (near-instant upload alerts) ─────────────
# Public HTTPS URL that YouTube's hub can reach, e.g. https://bot.example.com/websub
# (reverse-proxy it to WEBSUB_PORT). Leave blank to use polling only.
WEBSUB_CALLBACK_URL=
# Local port the websub HTTP server listens on (default 8080).
WEBSUB_PORT=
# Optional HMAC secret; when set, notification signatures are verified.
WEBSUB_SECRET=
```

- [ ] **Step 7: Full test run + lint, then commit**

Run: `node --test` then `npx eslint .`
Expected: all pass. Also sanity-load: `node -e "require('./systems/alerts/alerts.js')"`.

```bash
git add systems/alerts/websub.js systems/alerts/alerts.js systems/alerts/poller.js systems/alerts/queries.js config/alerts.config.js .env.example test/websub.test.js
git commit -m "feat: opt-in YouTube WebSub push endpoint with lease renewal"
```

---

### Task 9: Interaction snappiness (reply first, side effects after)

No new unit tests (all Discord-coupled); verification is `npx eslint .`, the full existing suite, and module load checks. Behavioural rule for every edit: the user-visible ack (`reply`/`editReply`/`update`/`showModal`) moves as early as possible; best-effort logging and panel refreshes become un-awaited with `.catch()`.

**Files:**

- Modify: `index.js` (client cache tuning)
- Modify: `systems/tickets/handlers.js`
- Modify: `systems/verify.js`
- Modify: `systems/vc/interactions.js`

- [ ] **Step 1: Client cache tuning in `index.js`**

Change the discord.js import to include `Options`:

```js
const {
  Client,
  Collection,
  GatewayIntentBits,
  Events,
  MessageFlags,
  Options,
} = require('discord.js');
```

Change the client construction to:

```js
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    // MessageContent (privileged) is kept: REST-fetched thread messages only
    // populate .content for the ticket transcript when it's granted. The
    // GuildMessages gateway intent was removed — nothing listens for live
    // messages, so streaming every guild message was pure wasted bandwidth.
    GatewayIntentBits.MessageContent,
  ],
  // Nothing consumes live message/reaction events (transcripts REST-fetch on
  // close), so caching them only burns memory and GC time.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    ReactionManager: 0,
  }),
});
```

Verify: `node -e "require('./index.js')"` is NOT safe (it logs in) — instead run `node --check index.js`.

- [ ] **Step 2: `systems/tickets/handlers.js` — reply before side effects**

a) `handleTicketModal`: move the final `await interaction.editReply({ content: ... })` to immediately AFTER `ticketState.set(thread.id, ...)` (before the overflow/files/log blocks), and change the trailing `await logTicket(...)` to un-awaited. The tail of the function becomes:

```js
  // Persist so claim/close/reopen across restarts can re-render this exact
  // ticket from disk. messageId is the V2 message we will edit later.
  ticketState.set(thread.id, { ...initialState, messageId: sentMessage.id });

  // Ack the user NOW — overflow text, file re-uploads and the log embed are
  // best-effort extras that shouldn't hold the confirmation hostage.
  await interaction.editReply({
    content: `✅ Your ticket has been created: ${thread}`,
  });

  // ... (existing overflowSections block, unchanged) ...
  // ... (existing uploadedFiles block, unchanged) ...

  logTicket(guild, {
    severity: 'info',
    title: `🆕 ${dep.label}`,
    description:
      `${interaction.user} opened ${thread}` +
      (uploadedFiles.length ? ` · 📎 ${uploadedFiles.length}` : ''),
  }).catch(() => {});
}
```

b) `handleClaim`: both `await logTicket(...)` calls become `logTicket(...).catch(() => {});` (new-format claim and legacy claim).

c) `handleAddUserSelect`: the trailing `await logTicket(...)` becomes `logTicket(...).catch(() => {});`.

d) `handleCloseModal`: parallelize the UI edit and transcript send, ack, then log. Replace everything from `// Send transcript to log` down to (and including) the `await interaction.editReply({ content: '🔒 Ticket closed and transcript saved.' });` with:

```js
// Update in-thread UI and deliver the transcript IN PARALLEL — they're
// independent REST calls — then ack. The log embed is fire-and-forget.
const state = ticketState.get(channel.id);

const uiUpdate = (async () => {
  if (state && state.messageId) {
    // New format: edit the merged container in-place (no extra message)
    const updatedState = {
      ...state,
      closed: true,
      closedById: interaction.user.id,
      closedReason: reason || undefined,
      closedAt: Date.now(),
    };
    ticketState.set(channel.id, updatedState);
    try {
      const msg = await channel.messages.fetch(state.messageId);
      await msg.edit({
        components: [buildTicketContainer(updatedState)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error(
        'Failed to edit ticket message on close, falling back to a separate closed panel:',
        err,
      );
      const closedPanel = buildClosedControlPanel(interaction.user, reason);
      await channel.send({
        components: [closedPanel],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
    }
  } else {
    // Legacy: send a separate closed-state panel
    const closedPanel = buildClosedControlPanel(interaction.user, reason);
    await channel.send({
      components: [closedPanel],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  }
})();

const transcriptDelivery = (async () => {
  const transcriptChannelId = guildConfig.getTicketConfig(guild.id).transcriptChannelId;
  const transcriptChannel = transcriptChannelId
    ? guild.channels.cache.get(transcriptChannelId)
    : null;
  if (transcriptChannel?.isTextBased()) {
    try {
      await transcriptChannel.send({
        content:
          `📄 Transcript for \`${channel.name}\` · closed by ${interaction.user}` +
          (reason ? `\n**Reason:** ${reason.slice(0, 1000)}` : ''),
        files: [attachment],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('Failed to deliver transcript:', err);
    }
  }
})();

await Promise.all([uiUpdate, transcriptDelivery]);

await interaction.editReply({
  content: '🔒 Ticket closed and transcript saved.',
});

logTicket(guild, {
  severity: 'success',
  title: '✅ Ticket closed',
  description:
    `${interaction.user} closed ${channel}` +
    (reason ? `\n**Reason:** ${reason.slice(0, 500)}` : ''),
}).catch(() => {});
```

(The old duplicated `state`/UI-edit block that used to live BELOW the transcript send must be deleted — it is now inside `uiUpdate`. The lock + delayed archive block after `editReply` stays unchanged.)

e) `handleReopen`: the trailing `await logTicket(...)` becomes `logTicket(...).catch(() => {});`.

- [ ] **Step 3: `systems/verify.js` — reply/modal before logs**

a) `runPreChecks` bot-block: swap the order — `await interaction.reply({...})` first, then `logVerify(guild, {...}).catch(() => {});` (un-awaited).

b) `runPreChecks` raid-trigger block: `await interaction.reply({...})` first, then `logVerify(...).catch(() => {});`.

c) `runPreChecks` account-too-new block: change `await logVerify(...)` to `logVerify(...).catch(() => {});` (reply already comes first there).

d) `handleVerifyButton` word-challenge branch: show the modal FIRST (it's the interaction ack and must beat the 3s window), then log:

```js
if (fastClicker && staticConfig.SECURITY.WORD_CHALLENGE.ENABLED) {
  const word = pickChallengeWord();
  await interaction.showModal(buildWordChallengeModal(word));
  if (staticConfig.SECURITY.LOG_FAILS) {
    logVerify(guild, {
      severity: 'info',
      title: '⏱ Word challenge issued',
      fields: [
        userField(interaction.user),
        { name: 'Joined', value: `${formatDuration(inServerMs)} ago`, inline: true },
        { name: 'Threshold', value: formatDuration(minJoinAge), inline: true },
        { name: 'Word', value: `\`${word}\``, inline: true },
      ],
    }).catch(() => {});
  }
  return;
}
```

e) `handleVerifyWordModal` fail branch: reply first, then `logVerify(...).catch(() => {});`.

f) `grantVerifiedRole`: the trailing `await logVerify(...)` becomes `logVerify(...).catch(() => {});`.

- [ ] **Step 4: `systems/vc/interactions.js` — defer REST-heavy branches, un-await refreshes**

a) `vc_privacy_cycle` branch: defer before the permission rewrites, editReply after, panel refresh un-awaited:

```js
if (action === 'vc_privacy_cycle') {
  const current = meta.privacy || 'public';
  const next = nextPrivacy(current);

  // Privacy = several permission-overwrite REST calls; defer so a slow batch
  // can't blow the 3s ack window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await applyPrivacy(voiceChannel, guild, meta, next);
  } catch (err) {
    console.error('Failed to apply privacy mode:', err);
    return interaction.editReply({
      content: '⚠️ Failed to update privacy. Check bot permissions and try again.',
    });
  }

  if (interaction.user.id === meta.ownerId && vcPrefs.isProfileEnabled(guild.id, meta.ownerId)) {
    vcPrefs.patchProfile(guild.id, meta.ownerId, { privacy: next });
  }

  const replyByMode = {
    public: '🔓 VC is now **Public**. Anyone with category access can join.',
    friends: '🤝 VC is now **Friends-only**. Owner, co-owners, and your friends list can join.',
    private: '🔒 VC is now **Private**. Only the owner and co-owners can join.',
  };
  await interaction.editReply({ content: replyByMode[next] });

  if (typeof voiceChannel.send === 'function') {
    sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
      console.error('Failed to refresh VC panel:', err),
    );
  }
  return;
}
```

b) `vc_autosave_toggle` branch: keep as-is except the trailing panel refresh becomes un-awaited (`sendVcPanel(...).catch(err => console.error('Failed to refresh VC panel:', err));`).

c) `vc_delete` branch: change `await logVcEvent(...)` to `logVcEvent(...).catch(() => {});`.

d) `vc_refresh` branch: reply first, refresh after:

```js
if (action === 'vc_refresh') {
  await interaction.reply({
    content: '🔄 VC panel refreshed.',
    flags: MessageFlags.Ephemeral,
  });
  if (typeof voiceChannel.send === 'function') {
    sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
      console.error('Failed to refresh VC panel:', err),
    );
  }
  return;
}
```

e) `handleVcModal` rename branch: channel renames are rate-limited to 2/10min by Discord — a queued rename can hang far past the 3s ack window, so defer first:

```js
if (isRename) {
  const newName = interaction.fields.getTextInputValue('vc_new_name');
  // Channel renames are rate-limited (2/10min); a queued rename can take
  // minutes. Defer keeps the token alive for up to 15 minutes.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await voiceChannel.setName(newName);

  if (interaction.user.id === meta.ownerId && vcPrefs.isProfileEnabled(guild.id, meta.ownerId)) {
    vcPrefs.patchProfile(guild.id, meta.ownerId, { name: newName });
  }

  await interaction.editReply({ content: `✅ VC renamed to **${newName}**.` });

  if (typeof voiceChannel.send === 'function') {
    sendVcPanel(voiceChannel, voiceChannel, guild).catch(err =>
      console.error('Failed to refresh VC panel:', err),
    );
  }
  return;
}
```

f) `handleVcModal` limit branch: keep validation reply as a plain reply (no REST work before it), but make the trailing panel refresh un-awaited as in (b).

g) `handleVcSelect`: in ALL branches (`vc_member_manage` ban/unban, legacy `vc_member_ban`/`vc_member_unban`, `vc_coowner_manage` add/remove): the pattern per branch is — validation replies stay plain `interaction.reply`; once a branch reaches its first REST mutation (`permissionOverwrites.edit` / `voice.disconnect`), insert `await interaction.deferReply({ flags: MessageFlags.Ephemeral });` before that first mutation and convert that branch's success `interaction.reply({ content, flags })` to `interaction.editReply({ content })`; every trailing `await sendVcPanel(...)` becomes un-awaited with `.catch()`; every trailing `await logVcEvent(...)` becomes `logVcEvent(...).catch(() => {});`.

- [ ] **Step 5: Verify**

Run: `node --check index.js && node --check systems/tickets/handlers.js && node --check systems/verify.js && node --check systems/vc/interactions.js`
Expected: no syntax errors

Run: `node --test` then `npx eslint .`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add index.js systems/tickets/handlers.js systems/verify.js systems/vc/interactions.js
git commit -m "perf: reply-first interaction handling, defer REST-heavy paths, trim caches"
```

---

### Task 10: Embed polish for `/alerts list`, `/config`, template preview

**Files:**

- Modify: `systems/alerts/alerts.js` (`alertsList`, `alertsTemplatePreview`)
- Modify: `commands/config.js` (`show` + `quick-setup` embed colors)

- [ ] **Step 1: Rebuild `alertsList`'s embed**

Replace the embed construction in `alertsList` (from `const embed = new EmbedBuilder()` through the `for (const r of rows.slice(0, 20))` loop) with:

```js
const PROVIDER_EMOJI = { youtube: '📺', twitch: '🟣' };

const embed = new EmbedBuilder()
  .setTitle('🔔 Alert subscriptions')
  .setColor(0x57f287)
  .setDescription(
    `**${rows.length}** subscription${rows.length === 1 ? '' : 's'} configured for this server.\n` +
      '-# `/alerts remove id:<id>` · `/alerts roles id:<id>` · `/alerts template id:<id>`',
  )
  .setTimestamp();

for (const r of rows.slice(0, 20)) {
  const types = safeJsonParse(r.types, []).map(displayType);
  const roles = safeJsonParse(r.mentionRoleIds, []);

  embed.addFields({
    name: `${PROVIDER_EMOJI[r.provider] ?? '🔔'} ${r.sourceLabel}${r.enabled ? '' : ' · ⛔ disabled'}`,
    value:
      `**Types:** ${types.length ? types.join(' · ') : 'none'} → <#${r.discordChannelId}>\n` +
      `**Roles:** ${roles.length ? roles.map(id => `<@&${id}>`).join(' ') : '_none_'}\n` +
      `**ID:** \`${r.id}\``,
  });
}

if (rows.length > 20) {
  embed.setFooter({ text: `Showing 20 of ${rows.length} — remove some to see the rest` });
}
```

- [ ] **Step 2: Polish `alertsTemplatePreview`**

In the preview embed, add a provider-colored accent. Replace `.setTitle('🔎 Template preview')` + `.setTimestamp()` chain start with:

```js
const embed = new EmbedBuilder()
  .setTitle('🔎 Template preview')
  .setColor(provider === 'twitch' ? 0x9146ff : 0xff0000)
  .setDescription(
    `**Subscription:** \`${row.id}\`\n` +
      `**Provider:** ${provider}\n` +
      `**Using:** ${hasCustom ? '✏️ custom template' : '📦 default template'}\n\n` +
      '**Preview:**\n' +
      previewText,
  )
  .setTimestamp();
```

- [ ] **Step 3: Status-colored `/config` embeds**

In `commands/config.js`, `show` branch: after `const problems = guildConfig.getConfigStatus(guildId);` change the embed to include a status color:

```js
const embed = new EmbedBuilder()
  .setTitle('🛠 Server Configuration')
  .setColor(problems.length ? 0xfee75c : 0x57f287);
```

(the rest of the chain unchanged). Same in the `quick-setup` branch:

```js
const embed = new EmbedBuilder()
  .setTitle('✅ Quick Setup Complete')
  .setColor(problems.length ? 0xfee75c : 0x57f287);
```

Note: in `quick-setup`, `problems` is computed AFTER the current embed construction — move the `const problems = guildConfig.getConfigStatus(guildId);` line to just BEFORE the `const embed = ...` so the color can use it (the later `if (problems.length)` block keeps working).

- [ ] **Step 4: Verify + commit**

Run: `node --test` then `npx eslint .` then `node --check systems/alerts/alerts.js commands/config.js`
Expected: all pass

```bash
git add systems/alerts/alerts.js commands/config.js
git commit -m "style: richer alerts list, template preview, and config embeds"
```

---

### Task 11: Docs, formatting sweep, final verification

**Files:**

- Modify: `docs/systems/alerts.md`, `docs/systems/config-and-whitelist.md`, `docs/setup.md`, `docs/overview.md`
- Modify: `README.md` (only if it repeats poll intervals / whitelist flow — check first)

- [ ] **Step 1: `docs/systems/alerts.md`**

Update the polling description: interval is now 60 s, feeds are fetched once per channel (not per subscription) with ETag conditional requests, and classification is cached per video per cycle. Add a new `## WebSub push (optional)` section:

```markdown
## WebSub push (optional)

Set `WEBSUB_CALLBACK_URL` (public HTTPS URL, reverse-proxied to `WEBSUB_PORT`,
default 8080) and optionally `WEBSUB_SECRET` (HMAC verification) in `.env`, and
the bot subscribes every YouTube channel to YouTube's PubSubHubbub hub. Uploads
then arrive within seconds of publish instead of at the next poll. Leases renew
automatically (hourly check); the RSS poller stays on as a safety net at a
relaxed 5-minute interval (`YOUTUBE_POLL_MS_WEBSUB`). Removing the last
subscription for a channel unsubscribes it. Leave `WEBSUB_CALLBACK_URL` blank
and nothing changes — polling-only mode.
```

Also document the embed upgrades (channel avatar author line, duration field, Twitch box art / viewers / started-ago) and the daily Twitch avatar refresh.

- [ ] **Step 2: `docs/systems/config-and-whitelist.md`**

Replace the "hand-edit allowed-guilds.json / run /add" first-run instructions with the two new flows:

```markdown
### First server (no chicken-and-egg)

Two ways to allow your first server before `/add` is usable:

1. **`.env` seed** — set `ALLOWED_GUILD_IDS=<your guild id>` before starting the
   bot; ids are merged into the allow-list at boot.
2. **DM approval** — just invite the bot. Joining a non-allowed server now DMs
   the owner (`OWNER_ID`) an approval card with **Approve** / **Leave** buttons
   instead of instantly leaving. No decision within 24 hours = the bot leaves.
   A startup sweep re-checks every current server, so restarts or missed DMs
   can't strand anything. If the DM cannot be delivered at all (closed DMs),
   the bot falls back to leaving immediately and logs a hint.
```

- [ ] **Step 3: `docs/setup.md` and `docs/overview.md`**

- `setup.md`: document `ALLOWED_GUILD_IDS`, `WEBSUB_CALLBACK_URL`, `WEBSUB_PORT`, `WEBSUB_SECRET` in the env table/section.
- `overview.md`: add the `wl_` prefix row to the interaction-router table (`wl_` → `handleWhitelistInteraction` → Whitelist), and update the alerts summary sentence to mention channel-deduped 60 s polling + optional WebSub push.

- [ ] **Step 4: Final sweep**

Run: `npx prettier --write .` then `npx eslint .` then `node --test`
Expected: clean tree of formatting diffs only, no lint errors, all tests pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: onboarding, websub, and polling model updates"
```

---

## Self-Review Checklist (run after all tasks)

1. **Spec coverage:** env seed (T1), DM approval (T2), avatars (T3), embeds (T4, T7, T10), conditional GET + 60s (T5, T6), channel dedupe + shared pipeline (T6), Twitch 429/avatars (T7), WebSub (T8), snappiness + cache tuning (T9), docs (T11). ✔
2. **Type consistency:** `processYoutubeChannel(ctx)` object signature is used by poller (T6) and websub (T8); `postAlert(sub, text, roleIds, embed)` exported by poller (T6) and injected into websub (T8); `buildTwitchEmbed({ login, displayName, avatarUrl, stream })` used in T7; `avatarUrl` column read via `SELECT *` everywhere.
3. **Existing tests:** `classifyVideo` gains `durationSec` (additive — old assertions still pass); `fetchYoutubeFeed` return shape changed from `{channelTitle, items}` to `{channelTitle, items, cacheEntry}` / `{notModified}` — only callers are the pipeline (updated) and new tests; `resolveUser` gains `avatarUrl` (additive).
