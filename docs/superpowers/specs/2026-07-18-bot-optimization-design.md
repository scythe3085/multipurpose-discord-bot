# Bot Optimization Pass — Design

**Date:** 2026-07-18
**Status:** Approved

## Goal

Make the bot faster and nicer to use in four areas, without a rewrite:

1. Faster + cheaper YouTube alert detection (smarter polling for everyone, optional WebSub push).
2. Hardened Twitch polling with richer data for embeds.
3. Snappier Discord interactions across all systems.
4. Painless first-server whitelist onboarding.
5. A visual upgrade for every embed the bot sends.

Explicitly out of scope: full rewrite/rebase (architecture is sound), Twitch EventSub
(Helix data lag makes 30 s polling near the practical limit), sharding, external databases.

## 1. YouTube polling — smarter default

Current behaviour: every 2 minutes, for **each** subscription, fetch that channel's RSS
feed and classify each unseen video via the Data API. N subscriptions to the same
channel = N feed fetches and N classification calls.

Changes (all in `systems/alerts/`):

- **Group by channel.** `pollYoutube()` groups subs by `sourceId`. Each distinct
  channel's feed is fetched once per cycle; each new video is classified once per
  cycle (per-cycle `Map<videoId, classified>` cache). Per-sub logic (seen-tracking,
  type filter, createdAt cutoff, templates, posting) is unchanged and stays per-sub.
- **Conditional requests.** Store `ETag`/`Last-Modified` per channel in an in-memory
  map; send `If-None-Match`/`If-Modified-Since` on feed fetches. A `304` skips
  parsing and classification entirely. In-memory only — a restart simply refetches.
- **Faster interval.** `YOUTUBE_POLL_MS` drops from 120 s to 60 s. Data API quota
  usage does not increase: classification only runs for genuinely new videos, and
  the dedupe above strictly reduces calls versus today.
- **Shared pipeline module.** The per-channel "fetch feed → classify new items →
  fan out to subs → post" flow is extracted to `systems/alerts/youtubePipeline.js`,
  used by both the poller and WebSub (below). Poller keeps ownership of timers,
  re-entrancy guards, and the quota-backoff state.

Concurrency: the existing `mapWithConcurrency` pool now iterates distinct
channels instead of subs. `YOUTUBE_POLL_CONCURRENCY` keeps its meaning.

## 2. YouTube WebSub push — optional near-instant mode

New module `systems/alerts/websub.js` using only `node:http` (no new dependencies).

Activation: entirely opt-in via `.env`:

- `WEBSUB_CALLBACK_URL` — public base URL (e.g. `https://bot.example.com/websub`).
  Absent → WebSub code never starts and nothing changes.
- `WEBSUB_PORT` — local listen port (default `8080`); the operator reverse-proxies
  the public URL to it.
- `WEBSUB_SECRET` — optional HMAC secret; when set, notification signatures
  (`X-Hub-Signature`, sha1) are verified and mismatches are dropped.

Behaviour:

- On init, subscribe every distinct YouTube `sourceId` to
  `https://pubsubhubbub.appspot.com/subscribe` with the callback URL; handle the
  hub's `GET` verification (echo `hub.challenge`).
- On notification `POST`, parse the Atom payload (reuse `fast-xml-parser`), then run
  the shared per-channel pipeline for the affected channel. `seen_items` claims make
  overlap with the poller harmless (no duplicate alerts by construction).
- **Lease renewal:** track lease expiry per channel; renew at ~80 % of the lease.
  State is in-memory; init re-subscribes everything on startup, so restarts self-heal.
- **Sub lifecycle:** `/alerts add` for a new channel triggers a subscribe;
  removing the last sub for a channel triggers a best-effort unsubscribe.
- **Fallback polling:** when WebSub is active, the RSS poller keeps running as a
  safety net at `YOUTUBE_POLL_MS_WEBSUB` (5 min default).

## 3. Twitch — harden, don't replace

- Keep 30 s batch polling (`getLiveStreams`), token cache, and per-batch isolation.
- On `429`, respect the `Ratelimit-Reset` header before retrying that batch once.
- Store the streamer's `profile_image_url` at subscribe time (already returned by
  the `users` call in `resolveUser`) in a new `avatarUrl` column; refresh all Twitch
  avatars once daily via one batched `users` call (100 ids per call).

## 4. Discord interaction snappiness

Audit every interaction handler (tickets, VC, verify, alerts, config) and apply:

- **Reply first, side-effects after.** Log-channel embeds, transcript notices, and
  other best-effort sends happen after the user-visible reply and are not awaited
  in the reply path (`.catch(console.error)` fire-and-forget, preserving existing
  error logging).
- **Parallelize independent REST calls** with `Promise.all` — e.g. ticket creation's
  member adds + panel send, VC permission overwrite batches.
- **Defer early** in any path where more than one REST call precedes the reply.
- **Client cache tuning** in `index.js`: `makeCache` with `MessageManager: 0` plus
  standard sweepers. Nothing consumes live message events (tickets fetch thread
  messages over REST at transcript time), so this is free memory/GC headroom.

Behavioural invariant: no user-visible ordering changes other than replies arriving
sooner; all existing permission checks stay in place.

## 5. First-server whitelist onboarding

Two complementary mechanisms (both requested):

- **`.env` seed:** optional `ALLOWED_GUILD_IDS` (comma-separated). On startup,
  merged into `config/allowed-guilds.json` via the existing `whitelist` module
  (persisted, deduped). Lets the first server be allowed before the bot ever runs.
- **DM approval flow:** on `guildCreate` for a non-whitelisted guild — and in a
  startup sweep over `client.guilds` (catches joins missed while offline):
  - DM the owner (`OWNER_ID`) an embed: guild name, ID, member count, join time,
    with buttons `wl_approve:<guildId>` / `wl_deny:<guildId>` (new `wl_` route in
    the component router; owner-only check in the handler).
  - **Approve** → `whitelist.add`, confirm in DM, bot stays.
  - **Leave** → bot leaves, confirm in DM.
  - **No decision** → auto-leave after 24 h (timer armed per pending guild;
    re-armed by the startup sweep, so restarts don't strand anything).
  - **DM fails** (closed DMs / no mutual) → fall back to today's behaviour: log
    loudly with a hint about `ALLOWED_GUILD_IDS`, and leave immediately.

Pending state is in-memory only; the startup sweep makes it self-healing.

## 6. Embed glow-up

- **YouTube alert embed:** author = channel name + channel avatar, linking to the
  channel page; video title linking to the video; full-size thumbnail (hqdefault,
  as today); a Duration field for VODs (duration already comes back from
  classification); type-specific accent colors (existing `COLORS`); timestamp =
  published time. Channel avatar is fetched once at subscribe time (Data API
  `channels.list part=snippet`, only when an API key is present) and stored in the
  new `avatarUrl` column; absent avatar degrades to today's plain author line.
- **Twitch alert embed:** author = display name + profile image linking to
  `twitch.tv/<login>`; stream title; game box art as the small thumbnail
  (`static-cdn.jtvnw.net/ttv-boxart/<game_id>-144x192.jpg`); existing Category and
  Viewers fields; "Started" shown via Discord relative timestamp from
  `stream.started_at`; existing 1280×720 preview image + cache-buster retained.
- **`/alerts list`:** clearer per-sub fields (provider emoji, type badges, channel
  and role mentions, copyable ID in an inline code block); green accent.
- **`/config show` / `quick-setup`:** status-colored embeds — green when
  everything essential is configured, yellow when warnings exist; otherwise the
  same field layout.
- **Template preview:** small polish (provider color, clearer custom/default label).
- **Tickets / VC / verify panels:** already Components V2 — untouched.

### DB migration

`systems/alerts/db.js` gains an idempotent `ALTER TABLE subscriptions ADD COLUMN
avatarUrl TEXT` guarded the same way as existing migrations (try/catch on
duplicate-column). No data backfill required; avatars lazily refresh for Twitch
via the daily sweep, YouTube rows without avatars simply render without one.

## Config & env surface (new/changed)

| Key                        | Where            | Default    | Meaning                                   |
| -------------------------- | ---------------- | ---------- | ----------------------------------------- |
| `YOUTUBE_POLL_MS`          | alerts.config.js | 60 000     | poll interval (was 120 000)               |
| `YOUTUBE_POLL_MS_WEBSUB`   | alerts.config.js | 300 000    | fallback interval when WebSub active      |
| `TWITCH_AVATAR_REFRESH_MS` | alerts.config.js | 86 400 000 | daily avatar refresh                      |
| `ALLOWED_GUILD_IDS`        | .env             | unset      | comma-separated whitelist seed            |
| `WEBSUB_CALLBACK_URL`      | .env             | unset      | public callback base URL (enables WebSub) |
| `WEBSUB_PORT`              | .env             | 8080       | local HTTP listen port                    |
| `WEBSUB_SECRET`            | .env             | unset      | HMAC secret for notification verification |

## Testing

Extend the existing `node --test` suite:

- youtubePipeline: channel grouping, per-cycle classification cache, per-sub
  fan-out, quota backoff preserved (mock fetch + in-memory queries).
- Conditional GET: 304 short-circuits; ETag map updates on 200.
- websub: `GET` challenge echo, HMAC accept/reject, Atom parse → pipeline call,
  lease-renewal scheduling (fake timers).
- whitelist seed: merge, dedupe, persistence via existing atomic write.
- Twitch: 429 retry honors reset header; embed builder output shape.
- Embed builders: pure-function snapshot-style assertions on field/author/thumbnail
  content for both providers.

## Docs

Update `docs/systems/alerts.md` (polling model, WebSub setup section),
`docs/systems/config-and-whitelist.md` (DM approval + env seed), `docs/setup.md`
and `.env.example` (new variables), `docs/overview.md` (router table gains `wl_`).
