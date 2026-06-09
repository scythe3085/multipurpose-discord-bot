# YouTube & Twitch Alerts

Post a Discord message whenever a YouTube channel uploads / goes live, or a Twitch streamer goes live. Subscriptions are stored in SQLite, polled on a timer, deduplicated per-item, and rendered as rich embeds with optional role mentions and custom message templates.

All setup is done in Discord via the `/alerts` command. There is no per-server config file for this system — everything lives in the database. The static tuning knobs (poll intervals, caps, default templates) are in [`config/alerts.config.js`](../../config/alerts.config.js).

> **Permissions:** every `/alerts` subcommand requires **Manage Server** on the invoking member (`isManager`). Non-managers get an ephemeral refusal.

---

## Requirements & graceful degradation

| Feature                                         | Needs                                             | Behaviour if the key is missing                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Twitch alerts (add + polling)                   | `TWITCH_CLIENT_ID` **and** `TWITCH_CLIENT_SECRET` | Fully **disabled**. `/alerts add provider:twitch` is rejected, and `pollTwitch()` returns early.                                                                                                                                    |
| YouTube live / upcoming detection + video title | `YOUTUBE_API_KEY`                                 | **Degraded.** Without the key the bot cannot detect live/upcoming streams or read the canonical title; it falls back to the RSS title and the `/shorts/` probe only (every video is `vod` or `shorts`, never `live`).               |
| YouTube `@handle` / `/user/` resolution         | `YOUTUBE_API_KEY`                                 | Handle and legacy-username lookups via the Data API are skipped; resolution then relies on the page-scrape fallback (which also handles `/c/` vanity URLs). Direct `UC...` ids and `/channel/UC...` URLs always work without a key. |

The bot logs a loud warning at startup (`validateAlertsEnv`) for each missing key, but does **not** crash — so under pm2 it can look healthy while silently never alerting. Check the logs after deploy.

These vars live in `.env`. See [Setup](../setup.md) and [Configuration & Whitelist](./config-and-whitelist.md) for the full environment.

---

## Commands

All subcommands live under `/alerts` ([`commands/alerts.js`](../../commands/alerts.js)) and reply ephemerally.

| Subcommand                 | Options                                   | Purpose                                                                   |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `/alerts add`              | `provider`, `channel`, `types`, `post_to` | Create a subscription.                                                    |
| `/alerts list`             | —                                         | Show all subscriptions for this server (up to 20 fields), with their IDs. |
| `/alerts remove`           | `id`                                      | Delete a subscription by ID.                                              |
| `/alerts roles`            | `id`                                      | Open the role-picker to (re)choose mention roles.                         |
| `/alerts template`         | `id`, `template`                          | Set a custom message template.                                            |
| `/alerts template-reset`   | `id`                                      | Revert to the built-in default template.                                  |
| `/alerts template-preview` | `id`                                      | Render the active template with placeholder sample data.                  |

### `/alerts add`

| Option     | Required | Notes                                                                         |
| ---------- | -------- | ----------------------------------------------------------------------------- |
| `provider` | yes      | Choice: `youtube` or `twitch`.                                                |
| `channel`  | yes      | The source channel (see _Accepted inputs_ below).                             |
| `types`    | yes      | Comma-separated alert types. YouTube: `vid`, `live`, `short`. Twitch: `live`. |
| `post_to`  | yes      | The text channel to post alerts into. Must be text-based.                     |

The `types` string is split on commas, lower-cased, and mapped through an alias table:

| You type            | Stored type |
| ------------------- | ----------- |
| `vid` or `vod`      | `vod`       |
| `short` or `shorts` | `shorts`    |
| `live`              | `live`      |

Anything not valid for the provider is dropped. For Twitch the `types` value is ignored and forced to `["live"]` regardless of what you pass. If no valid type survives, the add is rejected.

Because resolving a channel can hit the network, the handler calls `deferReply` first to avoid Discord's 3-second interaction timeout. After a successful add it immediately shows a **role-picker** (`RoleSelectMenuBuilder`, custom ID `alerts_roles:<subscriptionId>`) so you can pick mention roles in the same flow (optional — pick 0 to skip).

A subscription is a duplicate only if the **same source posts to the same Discord channel in the same guild**. The same source posting to two different channels is allowed.

---

## Accepted channel inputs

### YouTube (`resolveChannelId`)

Resolved to a canonical `UC...` channel id. Accepted forms:

- Direct channel id: `UCxxxxxxxxxxxxxxxxxxxxxx`
- `https://www.youtube.com/channel/UC...`
- `@handle` (bare) or `https://youtube.com/@handle`
- `https://youtube.com/user/<name>` (legacy username)
- `https://youtube.com/c/<vanity>` (vanity URL — **page-scrape only**, the Data API has no vanity lookup)
- A bare word (no `@`) is tried as a handle.

Resolution order: direct id → Data API (`forHandle` / `forUsername`, needs `YOUTUBE_API_KEY`) → page-scrape the channel page for the canonical `UC` id (capped at 4 MB). If nothing resolves, the add is rejected with guidance.

### Twitch (`resolveUser`)

The input is stripped of a leading `https://twitch.tv/` (and any trailing path) down to the bare login slug, then looked up via Helix `users?login=`. The subscription stores three fields:

- `sourceId` — the numeric broadcaster id (used for polling)
- `sourceLabel` — the cased display name (used in `{name}`)
- `sourceLogin` — the lowercase slug (used to build the `twitch.tv/...` URL)

---

## How polling works

The poller ([`poller.js`](../../systems/alerts/poller.js)) runs on `setInterval` timers started at boot. Each poll type has a re-entrancy guard so a slow cycle never overlaps itself. A daily sweep prunes old dedup rows.

| Timer              | Interval (config key)    | Default |
| ------------------ | ------------------------ | ------- |
| YouTube            | `YOUTUBE_POLL_MS`        | 2 min   |
| Twitch             | `TWITCH_POLL_MS`         | 30 s    |
| Prune `seen_items` | `SEEN_PRUNE_INTERVAL_MS` | 24 h    |

### YouTube cycle

1. Fetch every enabled YouTube subscription. They are polled with bounded **concurrency** (`YOUTUBE_POLL_CONCURRENCY`, default 4) — network waits overlap, but items _within_ one sub stay serial to preserve ordering.
2. For each sub, fetch the channel **RSS feed** (`https://www.youtube.com/feeds/videos.xml?channel_id=...`, with retries and browser-like headers). The feed is capped at `MAX_FEED_ITEMS_TO_CHECK` (15 — the full window YouTube returns) and **reversed to oldest-first** so a burst of uploads can't starve older unseen items below a cutoff.
3. For each feed item, in order:
   - Skip if already in `seen_items`.
   - If the video was published **before the subscription was created**, mark it seen and skip (no back-fill of old uploads).
   - **Classify** the video (see below) into `live` / `upcoming` / `shorts` / `vod`.
   - `upcoming` (a scheduled premiere/stream that hasn't started) is skipped **without** marking seen, so it fires when it actually goes live.
   - If the classified type isn't in the sub's `types`, mark it seen and skip.
   - Otherwise **claim** it (`markSeen` — an atomic `INSERT OR IGNORE`) _before_ sending, then post the embed.

#### YouTube classification (`classifyVideo`)

With `YOUTUBE_API_KEY`, the Data API `videos.list` (`snippet,contentDetails,liveStreamingDetails`) provides the title and live state:

- `liveBroadcastContent === 'upcoming'` → `upcoming`.
- Live now: `liveBroadcastContent === 'live'`, **or** `liveStreamingDetails` has an `actualStartTime` and no `actualEndTime` (this guards against old stream VODs that retain `liveStreamingDetails`).
- Duration > `SHORTS_MAX_DURATION` (180 s) → `vod` (skip the probe).
- Otherwise (≤180 s or unknown duration) → run the **Shorts probe** (`probeIsShort`): requests the `/shorts/<id>` URL with `redirect: manual`. A real Short returns 200; a normal video redirects to `/watch`. Inconclusive (blocked/timeout) falls back to the legacy heuristic of ≤60 s ⇒ short.

Without a key, classification can only run the probe: 200 ⇒ `shorts`, otherwise `vod`. No `live`/`upcoming` is ever produced.

**Data API quota handling:** if classification returns a `403` (almost always `quotaExceeded`), the whole cycle sets `quotaHit` and stops classifying — running sub-workers wind down and no new sub starts. Items that failed to classify are **not** marked seen, so they retry on the next cycle.

### Twitch cycle (`pollTwitch`)

1. Skip entirely if Twitch env vars are missing.
2. Collect all enabled Twitch subs whose `types` include `live`.
3. **Batch** their broadcaster ids into a single Helix `streams` call (`TWITCH_BATCH_SIZE`, up to 100 ids per request) → a `Map<user_id, stream>` of currently-live broadcasters. Each batch is isolated: one failing batch (429/5xx/network) doesn't blank the others, and a `401` forces a fresh app token and retries the batch once. App tokens are client-credentials tokens, cached until ~30 s before expiry.
4. For each sub that appears live:
   - Skip if the stream id is already seen.
   - **Re-live cooldown:** if this broadcaster already alerted within `TWITCH_RELIVE_COOLDOWN_MS` (30 min), mark the new stream id seen and skip the alert. A brief drop/reconnect mints a fresh stream id; this collapses it into one alert per session.
   - Claim the stream id, post the embed, then stamp `lastLiveAlertAt` (which arms the cooldown).

---

## Dedup & data model

The SQLite DB lives at `data/alerts.sqlite` (WAL mode), created automatically ([`db.js`](../../systems/alerts/db.js)). All SQL is funneled through [`queries.js`](../../systems/alerts/queries.js).

**`subscriptions`** — one row per alert:

| Column                   | Meaning                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `id`                     | UUID, shown in `/alerts list`, used by remove/roles/template.          |
| `guildId`                | Owning server (all handler queries are scoped to it).                  |
| `provider`               | `youtube` or `twitch`.                                                 |
| `sourceId`               | YouTube `UC` id / Twitch broadcaster id.                               |
| `sourceLabel`            | Display name / label.                                                  |
| `sourceLogin`            | Twitch lowercase login slug (NULL on pre-migration rows).              |
| `types`                  | JSON array, e.g. `["vod","live","shorts"]`.                            |
| `discordChannelId`       | Where alerts post.                                                     |
| `mentionRoleIds`         | JSON array of role ids to ping.                                        |
| `enabled`                | `1`/`0`.                                                               |
| `createdBy`, `createdAt` | Author + epoch ms (gates the "no back-fill" rule).                     |
| `customTemplate`         | Custom message template, or NULL for default.                          |
| `lastLiveAlertAt`        | Epoch ms of the last Twitch go-live alert (arms the re-live cooldown). |

`customTemplate`, `sourceLogin`, and `lastLiveAlertAt` are added by idempotent column migrations at startup, so an older DB upgrades in place.

**`seen_items`** — the dedup ledger, primary key `(subscriptionId, itemId)` where `itemId` is a YouTube `videoId` or a Twitch `streamId`. `markSeen` is an atomic `INSERT OR IGNORE`; because better-sqlite3 is synchronous, claiming an item before posting makes a duplicate alert impossible even if two cycles race. Rows older than `SEEN_RETENTION_DAYS` (90, far longer than any feed lookback) are pruned daily, so re-alerting an old item is impossible. Deleting a subscription also deletes its `seen_items`.

---

## Mention roles

Picked through the role-select menu shown after `/alerts add`, or re-opened later with `/alerts roles id:<id>`. Selections are de-duplicated and capped at `MAX_ROLE_MENTIONS` (10) and stored as a JSON array on the row.

When an alert posts, the chosen roles are prepended as `<@&id>` mentions, and `allowedMentions` is set to `{ roles, parse: [] }` — only those explicit roles are pinged; `@everyone`/`@here`/stray mentions in titles or templates are suppressed.

---

## Message templates

Each alert's text comes from a template (default or custom). Placeholders are substituted with `{key}` → value; unknown placeholders become empty strings.

| Placeholder | YouTube                                | Twitch                         |
| ----------- | -------------------------------------- | ------------------------------ |
| `{title}`   | Video title                            | (n/a — not provided to Twitch) |
| `{url}`     | Watch URL                              | `twitch.tv/<login>`            |
| `{name}`    | Channel title                          | Streamer display name          |
| `{channel}` | Channel title (legacy alias)           | —                              |
| `{type}`    | Display type: `vid` / `short` / `LIVE` | `LIVE`                         |

### Default templates (`config/alerts.config.js → TEMPLATES`)

```
youtube.vod    📺 **New YouTube video!**\n{title}\n{url}
youtube.live   🔴 **YouTube LIVE**\n{title}\n{url}
youtube.shorts 🩳 **New YouTube Short!**\n{title}\n{url}
twitch.live    🔴 **{name} is LIVE on Twitch!**\n{url}
```

### Setting a custom template

```
/alerts template id:<id> template:New upload: {title}\n{url}
```

Validation: the template must be non-empty, **under ~1900 chars** (leaving room under Discord's 2000 limit for role mentions/newlines), and **must contain `{url}`** so every alert has a clickable link. Reset to the built-in default with `/alerts template-reset id:<id>`. Preview the active template (custom if set, otherwise the provider default) against sample data with `/alerts template-preview id:<id>`.

---

## Rich embeds

Every alert includes both the template text **and** an embed.

**YouTube embed:** author = channel title, title = video title (linked to the watch URL), accent color by type (`COLORS.youtube`: live `0xff0000`, shorts `0xff2d55`, vod `0x3ba3ff`), image = `i.ytimg.com/vi/<id>/hqdefault.jpg`, timestamp = publish time.

**Twitch embed:** title = stream title (linked), color `0x9146ff`, plus inline fields when Helix provides them — **Category** (`game_name`) and **Viewers** (`viewer_count`, locale-formatted). The stream thumbnail is set only when a real `thumbnail_url` exists (Helix occasionally omits it at go-live, and an invalid URL would silently drop the alert).

---

## Limits & tuning (`config/alerts.config.js`)

| Key                         | Default | Effect                                                                         |
| --------------------------- | ------- | ------------------------------------------------------------------------------ |
| `YOUTUBE_POLL_MS`           | 2 min   | YouTube poll interval.                                                         |
| `TWITCH_POLL_MS`            | 30 s    | Twitch poll interval (cheap: one batched call).                                |
| `YOUTUBE_POLL_CONCURRENCY`  | 4       | YouTube subs polled in parallel per cycle.                                     |
| `MAX_FEED_ITEMS_TO_CHECK`   | 15      | RSS items inspected per sub. Lowering risks permanently missing burst uploads. |
| `MAX_SUBS_PER_GUILD`        | 25      | Per-server subscription cap (bounds Data API / fetch load).                    |
| `MAX_ROLE_MENTIONS`         | 10      | Max mention roles per subscription.                                            |
| `SHORTS_MAX_DURATION`       | 180     | Max Short length (s) before classification skips the probe.                    |
| `TWITCH_BATCH_SIZE`         | 100     | Helix `streams` ids per request.                                               |
| `TWITCH_RELIVE_COOLDOWN_MS` | 30 min  | Suppresses a repeat go-live alert from a reconnect.                            |
| `SEEN_RETENTION_DAYS`       | 90      | `seen_items` retention before the daily prune.                                 |
| `SEEN_PRUNE_INTERVAL_MS`    | 24 h    | Prune sweep interval.                                                          |
| `COLORS`, `TEMPLATES`       | —       | Embed accent colors and default templates.                                     |

---

## Related docs

- [Setup](../setup.md) — installing deps, `.env`, deploying commands.
- [Configuration & Whitelist](./config-and-whitelist.md) — env vars and the guild whitelist.
- [Systems overview](../../README.md) — the other four bot systems.
