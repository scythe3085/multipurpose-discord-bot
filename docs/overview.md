# Overview & Architecture

A single, self-hostable [discord.js](https://discord.js.org/) v14 bot that bundles **five independent systems**, each isolated per guild. It runs as one Node.js process (no sharding, no microservices), persists state to local files, and only stays in servers you explicitly allow-list.

This page explains what the bot does and how it is wired together. For installation and environment setup, see [Setup](./setup.md).

---

## The five systems at a glance

| System                       | What it does                                                                       | Doc                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 🎫 Tickets                   | Button-driven support tickets in private threads, with claim / close / transcript  | [Tickets](./systems/tickets.md)                         |
| ✅ Verification              | Gate new members behind a verify button with account-age and anti-raid checks      | [Verification](./systems/verification.md)               |
| 🔊 Temporary Voice Channels  | "Join to Create" voice channels the joiner co-owns (rename, lock, limit, block)    | [Voice](./systems/temp-voice.md)                        |
| 📺 YouTube / Twitch Alerts   | Polls for new uploads / Shorts / livestreams and posts rich embeds with role pings | [Alerts](./systems/alerts.md)                           |
| 🛡️ Configuration & Whitelist | Per-guild setup via `/config`, plus the owner-only guild allow-list                | [Config & Whitelist](./systems/config-and-whitelist.md) |

Each system owns its own files under `systems/` and a unique `customId` namespace, so they never interfere with one another.

---

## What the bot is for

The bot is meant to be self-hosted by a developer for their own Discord server (or a small set of servers). One process gives you a support-ticket workflow, a verification gate, self-service temporary voice channels, and live-stream/upload notifications — without running four separate bots.

Per-server behaviour (which channels, which roles) is configured **live in Discord** with the `/config` command, not through environment variables. The only things that live in `.env` are credentials and the bot owner's ID. See [Setup](./setup.md) and [Config & Whitelist](./systems/config-and-whitelist.md).

---

## High-level architecture

### Single Node process

The entry point is `index.js`. It runs as **one** Node.js process — designed to sit under [pm2](https://pm2.keymetrics.io/) on a small VPS. There is no sharding and no clustering: the process holds in-memory state (alert poll timers, the SQLite handle, the in-memory whitelist), so a second instance would race against the first. Keep pm2 `instances` at **1**.

On startup (`Events.ClientReady`), `index.js` initialises the systems that need warm-up:

- `initVcSystem(client)` — rebuilds temporary-voice tracking.
- `initAlertsSystem(client)` — starts the YouTube/Twitch poll loops.

### Commands

Slash commands are one file per command in `commands/`. At boot, `index.js` reads that directory and registers every module exporting both `data` and `execute` into a `Collection` (`client.commands`). The command set is:

| Command        | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `/config`      | Per-guild setup (`show`, `quick-setup`, `set-*`)       |
| `/ticket`      | Post the ticket panel / manage tickets                 |
| `/verify`      | Post the verify panel / verify members                 |
| `/voice`       | Owner controls for your temporary voice channel        |
| `/alerts`      | Configure YouTube/Twitch notifications for this server |
| `/ping`        | Latency check                                          |
| `/add`         | **Owner-only** — add a guild ID to the whitelist       |
| `/removeguild` | **Owner-only** — remove a guild ID and auto-leave it   |

Commands are registered with Discord by a separate script: `npm run deploy-commands`. Run it once, and again any time a command's definition changes.

### The interaction router (customId-prefix dispatch)

`index.js` listens on a single `Events.InteractionCreate` handler and routes in two stages:

1. **Slash commands** — `interaction.isChatInputCommand()` looks up the command in `client.commands` and calls its `execute`.
2. **Components & modals** — buttons, select menus, and modal submits are dispatched by their **`customId` prefix** against an ordered dispatch table. The first matching route wins:

   | customId prefix | Handler                        | System                     |
   | --------------- | ------------------------------ | -------------------------- |
   | `wl_`           | `handleWhitelistInteraction`   | Whitelist (guild approval) |
   | `alerts_roles:` | `handleAlertsInteraction`      | Alerts                     |
   | `ticket_`       | `handleTicketComponentOrModal` | Tickets                    |
   | `vc_`           | `handleVcInteraction`          | Voice                      |
   | `verify_`       | `handleVerifyInteraction`      | Verification               |

Because each system owns a distinct prefix, the prefix alone identifies the handler — there is no need to also branch on component type. (For example, both `vc_member_` and `vc_coowner_manage` controls fall under the single `vc_` prefix.) The verify route covers both the panel button — whose `customId` defaults to `verify_button` (see `config/verify.config.js`) — and the word-challenge modal.

Any unrouted interaction is ignored; thrown errors are caught centrally and answered with an ephemeral error reply.

### Persistence: SQLite for alerts, atomic-JSON for everything else

The bot uses no external database server.

- **Alerts** use [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — a synchronous, embedded SQLite database (subscriptions, seen-item dedup, Twitch live-state). See [Alerts](./systems/alerts.md).
- **Everything else** uses small JSON files written through a crash-safe helper. `systems/atomicJson.js` writes to a temp file and renames it into place, so a crash mid-write can never corrupt the live file; `systems/store.js` is a shared key/value store factory built on top of it.

Runtime JSON state lives in `config/` (the guild whitelist, per-guild config, VC preferences) and `data/`. These files are **gitignored** and created on first write; the committed `*.example.json` files are templates. Static, code-level tunables live in `config/*.config.js` (committed) — for example poll intervals and limits in `config/alerts.config.js`, ticket departments in `config/tickets.config.js`, the VC creation cooldown in `config/vc.config.js`, and the account-age gate in `config/verify.config.js`.

### The guild whitelist

`systems/whitelist.js` is the single source of truth for which servers the bot may serve. It is consulted by the owner-only `/add` and `/removeguild` commands and enforced on `guildCreate`. Joining a guild that is **not** allow-listed no longer means an instant leave: `systems/guildApproval.js` DMs the bot owner (`OWNER_ID`) an Approve/Leave card (customId prefix `wl_`), auto-leaving only if there's no response within 24 hours, the DM can't be delivered, or `OWNER_ID` is unset. A startup sweep re-checks every current guild so restarts or missed DMs can't strand anything. To skip the DM step entirely, seed `ALLOWED_GUILD_IDS` in `.env` before the guild is even invited. See [Config & Whitelist](./systems/config-and-whitelist.md).

### Gateway intents

The client requests a deliberately minimal set of intents (`index.js`):

| Intent             | Why                                                      |
| ------------------ | -------------------------------------------------------- |
| `Guilds`           | Core guild, channel, and interaction events              |
| `GuildVoiceStates` | Drives the temporary voice-channel "join to create" flow |
| `MessageContent`   | **Privileged** — see below                               |

`MessageContent` is a **privileged** intent and must be enabled on the bot in the Discord Developer Portal (Bot tab → Privileged Gateway Intents). It is used **only** so that REST-fetched thread messages carry their `.content` when building **ticket transcripts**. The bot does _not_ subscribe to the live `GuildMessages` gateway intent — nothing listens for live messages, so streaming every guild message would be wasted bandwidth. The Server Members and Presence intents are not used.

For the same reason, the client's message and reaction caches are disabled entirely (`MessageManager: 0`, `ReactionManager: 0` via `Options.cacheWithLimits`) — nothing in the bot consumes live message or reaction events, so caching them would only cost memory and GC time for no benefit. Ticket transcripts are built by REST-fetching thread messages on close, not from the cache.

---

## System summaries

### 🎫 Tickets

Members open private-thread support tickets from a panel of department buttons (the departments are defined statically in `config/tickets.config.js` — e.g. Contact Owner, Twitch Mod, Discord Mod). Each ticket opens a modal form, creates a private thread, and gives staff claim / close / transcript controls. A per-user cooldown throttles ticket spam. All ticket UI lives under the `ticket_` customId prefix. See [Tickets](./systems/tickets.md).

### ✅ Verification

New members click a Verify button to gain a configured verified role. The gate (in `config/verify.config.js`) enforces a minimum Discord **account age**, and — if a user clicks suspiciously soon after joining — issues a short typed **word challenge** rather than rejecting them outright. Built-in raid protection locks verification when attempts spike. UI lives under the `verify_` prefix. See [Verification](./systems/verification.md).

### 🔊 Temporary Voice Channels

A configured "Join to Create" channel spawns a personal voice channel that the joiner **co-owns**. Owners use `/voice` and in-channel controls (the `vc_` prefix) to rename, lock, set a user limit, and block/unblock or friend other users; preferences persist in a JSON store. Empty temp channels are cleaned up automatically. See [Voice](./systems/temp-voice.md).

### 📺 YouTube / Twitch Alerts

Per guild, `/alerts` subscribes channels to YouTube uploads/Shorts/livestreams and Twitch live alerts; the poller posts rich embeds with optional role pings into a target channel. YouTube subscriptions are polled channel-deduped (one feed fetch and one classification per channel per cycle, regardless of how many subscriptions point at it) every 60 seconds, with conditional (ETag) requests to avoid re-fetching unchanged feeds; an optional WebSub push mode (`WEBSUB_CALLBACK_URL`) delivers new uploads within seconds and relaxes the poller to a 5-minute safety-net interval. State is stored in SQLite, and tunables (poll intervals, per-guild subscription caps, embed colours, message templates) live in `config/alerts.config.js`. YouTube and Twitch each require their own API credentials and **silently degrade/disable** when those keys are absent. See [Alerts](./systems/alerts.md).

### 🛡️ Configuration & Whitelist

`/config` (`show`, `quick-setup`, and `set-*` subcommands) configures all per-guild channels and roles used by Tickets, Verification, and Voice — stored per guild in JSON, never in `.env`. Separately, the owner-only `/add` and `/removeguild` commands manage the guild **whitelist** that controls which servers the bot will stay in. See [Config & Whitelist](./systems/config-and-whitelist.md).

---

## See also

- [Setup](./setup.md) — install, `.env`, intents, and first run
- [Tickets](./systems/tickets.md) · [Verification](./systems/verification.md) · [Voice](./systems/temp-voice.md) · [Alerts](./systems/alerts.md) · [Config & Whitelist](./systems/config-and-whitelist.md)
