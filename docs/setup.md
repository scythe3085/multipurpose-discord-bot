# Setup Guide

First-time setup for self-hosting **multipurpose-discord-bot** — a single-process discord.js v14 bot with five systems: Tickets, Verification, Temporary Voice Channels, YouTube/Twitch Alerts, and Configuration/Whitelist.

Follow the steps in order. By the end you will have the bot running, its slash commands registered, and one Discord server configured.

---

## 1. Prerequisites

| Requirement                              | Notes                                                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js ≥ 20**                         | Required by `package.json` (`engines.node: ">=20"`). `better-sqlite3` ships prebuilt binaries for current LTS releases, so no compiler toolchain is needed on supported platforms. |
| **npm**                                  | Bundled with Node. Used for install and the project scripts.                                                                                                                       |
| **Discord application + bot token**      | Created at <https://discord.com/developers/applications>. Provides `DISCORD_TOKEN` and `CLIENT_ID`.                                                                                |
| **YouTube Data API v3 key** _(optional)_ | Only needed for YouTube alerts. From <https://console.cloud.google.com/>.                                                                                                          |
| **Twitch application** _(optional)_      | Only needed for Twitch alerts. From <https://dev.twitch.tv/console/apps>. Provides `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.                                                  |

The bot runs as a **single Node.js process** with no external services beyond Discord and the optional YouTube/Twitch APIs. It stores state in local JSON files (`config/`) plus a SQLite database (`data/`), all gitignored.

> The YouTube and Twitch alert systems **degrade gracefully**: if a provider's keys are missing, that provider's alerts are simply disabled. Everything else runs without them.

---

## 2. Create the Discord application and invite the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. **Bot token** — open the **Bot** tab, click **Reset Token**, and copy the value. This is your `DISCORD_TOKEN`. Keep it secret.
3. **Application (client) ID** — open the **General Information** tab and copy the **Application ID**. This is your `CLIENT_ID`.
4. **Enable the Message Content privileged intent** — on the **Bot** tab, under **Privileged Gateway Intents**, turn on **Message Content Intent**. The bot uses it only to capture message text for ticket transcripts. It does **not** use the Server Members or Presence intents.
5. **Invite the bot** — build an OAuth2 invite URL with:
   - **Scopes:** `bot` and `applications.commands`
   - **Permissions:** enough to manage channels, roles, and threads for the systems you intend to use (tickets create threads, verification assigns a role, temp VCs create/move voice channels, alerts post embeds).

   Then open the URL and add the bot to your server.

> The bot enforces a **guild whitelist**. If your server isn't on the allow-list yet, the bot DMs the owner (`OWNER_ID`) an Approve/Leave card instead of leaving immediately — or you can pre-seed the allow-list via `ALLOWED_GUILD_IDS` in `.env` before inviting it. See [Step 7](#7-whitelist-and-configure-your-server).

---

## 3. Clone and install

```bash
git clone https://github.com/scythe3085/discord-bots.git
cd discord-bots/multipurpose-discord-bot
npm install
```

`npm install` pulls in `discord.js`, `better-sqlite3`, `dotenv`, and `fast-xml-parser` (plus the dev tooling for lint/format).

---

## 4. Fill in `.env`

Copy the template and edit it:

```bash
cp .env.example .env
```

Every variable in `.env.example`, in order:

| Variable               | Required | What it is / where to get it                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_TOKEN`        | ✅       | Bot token. Developer Portal → your app → **Bot** tab → **Reset Token**. Keep it secret.                                                                                                                                                                                                                                                                |
| `CLIENT_ID`            | ✅       | Application (client) ID. Developer Portal → **General Information** tab → **Application ID**. Used to register slash commands.                                                                                                                                                                                                                         |
| `OWNER_ID`             | ✅       | **Your own Discord user ID.** Enable Developer Mode in Discord, then right-click yourself → **Copy User ID**. Gates the owner-only `/add` and `/removeguild` commands, and is who the whitelist DM-approval flow messages. **If this is unset, those commands deny everyone** — including you — and unapproved guilds get no DM (the bot just leaves). |
| `ALLOWED_GUILD_IDS`    | ➖       | Optional. Comma-separated guild IDs merged into the allow-list at boot — pre-seeds your first server so you don't have to rely on the DM approval flow or run `/add` from inside an already-allowed guild.                                                                                                                                             |
| `GUILD_ID`             | ➖       | Optional. Used **only** by `npm run deploy-commands` to clear leftover guild-scoped commands on your main/test guild. Safe to leave blank for a global-only deploy.                                                                                                                                                                                    |
| `YOUTUBE_API_KEY`      | ➖       | Optional. YouTube Data API v3 key from <https://console.cloud.google.com/> (enable "YouTube Data API v3"). Leave blank to **disable YouTube alerts**.                                                                                                                                                                                                  |
| `TWITCH_CLIENT_ID`     | ➖       | Optional. Twitch app credential from <https://dev.twitch.tv/console/apps>. Leave blank to **disable Twitch alerts**.                                                                                                                                                                                                                                   |
| `TWITCH_CLIENT_SECRET` | ➖       | Optional. The matching Twitch app secret. Leave blank to **disable Twitch alerts**.                                                                                                                                                                                                                                                                    |
| `WEBSUB_CALLBACK_URL`  | ➖       | Optional. Public HTTPS URL that YouTube's PubSubHubbub hub can reach (reverse-proxied to `WEBSUB_PORT`), enabling near-instant push notifications for new uploads instead of waiting for the next poll. Leave blank to stay in polling-only mode.                                                                                                      |
| `WEBSUB_PORT`          | ➖       | Optional. Local port the WebSub HTTP server listens on. Defaults to `8080`. Only relevant when `WEBSUB_CALLBACK_URL` is set.                                                                                                                                                                                                                           |
| `WEBSUB_SECRET`        | ➖       | Optional. HMAC secret used to verify incoming WebSub notifications. Strongly recommended whenever `WEBSUB_CALLBACK_URL` is set, since that endpoint is reachable from the internet.                                                                                                                                                                    |

> Twitch alerts need **both** `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`. If either is missing, Twitch alerts stay off.

`.env` is gitignored — it is never committed.

---

## 5. Register slash commands

```bash
npm run deploy-commands
```

This runs `deploy-commands.js`, which reads every file in `commands/` and registers the slash commands (`/add`, `/alerts`, `/config`, `/ping`, `/removeguild`, `/ticket`, `/verify`, `/voice`) **globally** with Discord using `DISCORD_TOKEN` and `CLIENT_ID`.

If `GUILD_ID` is set, the script also **clears** any leftover guild-scoped commands on that one guild (useful when migrating from guild-scoped to global commands).

> Re-run `npm run deploy-commands` whenever a command's **definition** changes (new subcommand, renamed option, etc.). Routine code changes that don't touch the command schema don't need it.
>
> Global command registration can take a little while to propagate across Discord.

---

## 6. Start the bot

For local runs or testing:

```bash
npm start
```

This runs `node index.js`. The bot logs in, loads commands, and starts its systems.

For a long-running deployment (VPS, auto-restart, log management), run it under a process manager such as pm2 — see [Deployment](./deployment.md).

---

## 7. Whitelist and configure your server

The bot only stays in guilds on its whitelist. There are three ways to get your first server onto it:

### 7a. Whitelist your server

**Option 1 — pre-seed via `.env` (no chicken-and-egg):** before starting the bot, set `ALLOWED_GUILD_IDS=<your-guild-id>` in `.env` (Developer Mode → right-click the server → **Copy Server ID**). Ids are merged into the allow-list at boot, so your invite is accepted immediately.

**Option 2 — DM approval (just invite the bot):** if your server isn't already allow-listed when you invite the bot, it DMs the user in `OWNER_ID` an approval card (server name/ID/member count, with **Approve** / **Leave** buttons) instead of leaving right away. Click **Approve** to add it to the allow-list. If you don't respond within 24 hours, the bot leaves automatically. A startup sweep also re-checks every current guild, so a restart or a missed DM can't strand the bot in limbo. If the owner's DMs are closed (or `OWNER_ID` is unset), the bot falls back to leaving immediately.

**Option 3 — `/add` from an already-allowed guild:** once the bot is in at least one allowed server, the owner can run, in Discord:

```text
/add guild id:<your-guild-id>
```

`<your-guild-id>` is validated as a Discord snowflake and added to the allow-list; new invites to that guild are then accepted.

### 7b. Per-server setup with `/config`

Per-server settings (channels and roles for tickets, verification, and voice) are **not** in `.env` — they are configured live with `/config` and stored per guild. The `/config` command requires the **Administrator** permission.

Subcommands:

| Subcommand            | Purpose                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `/config show`        | Display the current configuration and any setup warnings for this server.              |
| `/config quick-setup` | Guided one-shot setup — set all the common fields at once (recommended for first run). |
| `/config set-*`       | Set a single field. One subcommand per field (see table below).                        |

#### `/config quick-setup` options

Two options are **required**, the rest are optional:

| Option             | Required | Maps to                  | Meaning                                                                                                  |
| ------------------ | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `ticket_log`       | ✅       | `ticketLogChannelId`     | Log channel for ticket events / transcripts.                                                             |
| `verified_role`    | ✅       | `verifiedRoleId`         | Role granted when a user verifies.                                                                       |
| `transcript_log`   | ➖       | `transcriptChannelId`    | Channel where ticket transcripts are sent. Defaults to `ticket_log`; if unset, transcripts are disabled. |
| `owner_role`       | ➖       | `ticketOwnerRoleId`      | Role pinged for "Contact Owner" tickets.                                                                 |
| `twitch_mod_role`  | ➖       | `ticketTwitchModRoleId`  | Role pinged for "Contact Twitch Mod" tickets.                                                            |
| `discord_mod_role` | ➖       | `ticketDiscordModRoleId` | Role pinged for "Contact Discord Mod" tickets.                                                           |
| `verify_log`       | ➖       | `verifyLogChannelId`     | Channel for verification logs. Falls back to the ticket log if unset.                                    |
| `join_vc`          | ➖       | `joinToCreateVcId`       | "Join to Create" voice channel. **Must be a voice channel.**                                             |
| `vc_category`      | ➖       | `vcCategoryId`           | Category where temporary VCs are created. **Must be a category.**                                        |

Example:

```text
/config quick-setup ticket_log:#ticket-logs verified_role:@Verified join_vc:🔊 Join to Create vc_category:Temp VCs
```

#### Single-field setters

To change one value later, use the matching `set-*` subcommand instead of re-running quick-setup:

| Subcommand                     | Option              | Config key               |
| ------------------------------ | ------------------- | ------------------------ |
| `/config set-ticket-log`       | `channel`           | `ticketLogChannelId`     |
| `/config set-transcript-log`   | `channel`           | `transcriptChannelId`    |
| `/config set-owner-role`       | `role`              | `ticketOwnerRoleId`      |
| `/config set-twitch-mod-role`  | `role`              | `ticketTwitchModRoleId`  |
| `/config set-discord-mod-role` | `role`              | `ticketDiscordModRoleId` |
| `/config set-verified-role`    | `role`              | `verifiedRoleId`         |
| `/config set-verify-log`       | `channel`           | `verifyLogChannelId`     |
| `/config set-join-vc`          | `channel` _(voice)_ | `joinToCreateVcId`       |
| `/config set-vc-category`      | `category`          | `vcCategoryId`           |

Run `/config show` afterwards to confirm everything essential is configured — it reports **setup warnings** for anything missing.

---

## Next steps

- [Deployment](./deployment.md) — running under pm2 and updating an existing install.
- [Tickets](./systems/tickets.md), [Verification](./systems/verification.md), [Voice Channels](./systems/temp-voice.md), [Alerts](./systems/alerts.md) — system-specific configuration and usage.

> Each system is independent and per-guild. You only need to configure the ones you use — for example, you can skip `join_vc`/`vc_category` entirely if you aren't using temporary voice channels.
