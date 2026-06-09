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

> The bot enforces a **guild whitelist**: it auto-leaves any server not on the allow-list. You will whitelist your server in [Step 7](#7-whitelist-and-configure-your-server).

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

| Variable               | Required | What it is / where to get it                                                                                                                                                                                                               |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_TOKEN`        | ✅       | Bot token. Developer Portal → your app → **Bot** tab → **Reset Token**. Keep it secret.                                                                                                                                                    |
| `CLIENT_ID`            | ✅       | Application (client) ID. Developer Portal → **General Information** tab → **Application ID**. Used to register slash commands.                                                                                                             |
| `OWNER_ID`             | ✅       | **Your own Discord user ID.** Enable Developer Mode in Discord, then right-click yourself → **Copy User ID**. Gates the owner-only `/add` and `/removeguild` commands. **If this is unset, those commands deny everyone** — including you. |
| `GUILD_ID`             | ➖       | Optional. Used **only** by `npm run deploy-commands` to clear leftover guild-scoped commands on your main/test guild. Safe to leave blank for a global-only deploy.                                                                        |
| `YOUTUBE_API_KEY`      | ➖       | Optional. YouTube Data API v3 key from <https://console.cloud.google.com/> (enable "YouTube Data API v3"). Leave blank to **disable YouTube alerts**.                                                                                      |
| `TWITCH_CLIENT_ID`     | ➖       | Optional. Twitch app credential from <https://dev.twitch.tv/console/apps>. Leave blank to **disable Twitch alerts**.                                                                                                                       |
| `TWITCH_CLIENT_SECRET` | ➖       | Optional. The matching Twitch app secret. Leave blank to **disable Twitch alerts**.                                                                                                                                                        |

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

The bot leaves any guild that is not on its whitelist, so this step happens **in Discord** after the bot is online and invited.

### 7a. Whitelist your server (owner only)

As the user whose ID is in `OWNER_ID`, run:

```text
/add guild id:<your-guild-id>
```

`<your-guild-id>` is your server's ID (Developer Mode → right-click the server → **Copy Server ID**). The bot validates it as a Discord snowflake and adds it to the allow-list; new invites to that guild are then accepted.

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
