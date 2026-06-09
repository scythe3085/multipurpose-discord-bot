# Multipurpose Discord Bot

A single, self-hostable [discord.js](https://discord.js.org/) v14 bot that bundles five independent systems, each fully isolated per guild:

| System                         | What it does                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 🎫 **Tickets**                 | Button-driven support tickets in private threads with claim / close / transcript                        |
| ✅ **Verification**            | Gate new members behind a verify button with account-age checks and a verified role                     |
| 🔊 **Temp voice channels**     | "Join to Create" voice channels the joiner co-owns: rename, lock, set limits, block users, friends list |
| 📺 **YouTube / Twitch alerts** | Polls for new uploads / Shorts / livestreams and posts rich embeds with role pings                      |
| 🛡️ **Guild whitelist**         | The bot only stays in explicitly allow-listed servers and auto-leaves the rest                          |

It runs as a **single Node.js process** (no sharding, no external services beyond Discord and the optional YouTube/Twitch APIs) and stores state in local JSON files plus a SQLite database — designed to sit happily on a small VPS under [pm2](https://pm2.keymetrics.io/).

## 📖 Documentation

Full docs live in [`docs/`](./docs/README.md):

- **[Overview & Architecture](./docs/overview.md)** — what the bot is for and how it is wired together
- **[Setup Guide](./docs/setup.md)** — install, `.env`, intents, registering commands, first run
- **[Deployment & Operations](./docs/deployment.md)** — pm2, the update procedure, and backups
- **Systems:** [Tickets](./docs/systems/tickets.md) · [Verification](./docs/systems/verification.md) · [Temp Voice](./docs/systems/temp-voice.md) · [Alerts](./docs/systems/alerts.md) · [Config & Whitelist](./docs/systems/config-and-whitelist.md)

---

## Requirements

- **Node.js ≥ 20** (`better-sqlite3` ships prebuilt binaries for current LTS releases)
- A Discord application + bot token — https://discord.com/developers/applications
- _(optional)_ a **YouTube Data API v3** key for YouTube alerts
- _(optional)_ **Twitch application** credentials for Twitch alerts

### Required Discord setup

- **Privileged intents:** enable **Message Content Intent** on the bot (Bot tab → Privileged Gateway Intents). It is used only to capture message text for ticket transcripts. The bot does **not** use the Server Members or Presence intents.
- **Invite scopes:** `bot` + `applications.commands`, with permissions for managing channels/roles/threads as needed by the systems you use.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#   then edit .env and fill in DISCORD_TOKEN, CLIENT_ID, OWNER_ID (see below)

# 3. Register slash commands with Discord (run once, and after any command change)
npm run deploy-commands

# 4. Start the bot
npm start
```

The bot leaves any guild that is not on its whitelist. To allow your own server, run **`/add guild id:<your-guild-id>`** as the owner once the bot is running and invited.

---

## Configuration (`.env`)

Copy `.env.example` → `.env` and fill in the values. See `.env.example` for inline notes.

| Variable               | Required | Purpose                                                                                                           |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`        | ✅       | Bot token                                                                                                         |
| `CLIENT_ID`            | ✅       | Application (client) ID — used to register slash commands                                                         |
| `OWNER_ID`             | ✅       | Your Discord user ID. Gates the owner-only `/add` and `/removeguild`. **If unset, those commands deny everyone.** |
| `GUILD_ID`             | ➖       | Optional. Used only by `deploy-commands` to clear leftover guild-scoped commands on a test guild                  |
| `YOUTUBE_API_KEY`      | ➖       | Enables YouTube alerts                                                                                            |
| `TWITCH_CLIENT_ID`     | ➖       | Enables Twitch alerts                                                                                             |
| `TWITCH_CLIENT_SECRET` | ➖       | Enables Twitch alerts                                                                                             |

Per-guild settings (ticket/verify/VC channels and roles) are **not** in `.env` — they are configured live with `/config` and stored per guild.

---

## Commands

| Command                                                                                          | Who             | Description                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/config show` · `/config quick-setup` · `/config set ...`                                       | Admin           | Configure this server: ticket log/transcript channels, contact roles, verified role, verify log, Join-to-Create VC and category |
| `/ticket ...`                                                                                    | Admin / members | Post the ticket panel and manage tickets                                                                                        |
| `/verify ...`                                                                                    | Admin / members | Post the verify panel and verify members                                                                                        |
| `/voice block` · `unblock` · ...                                                                 | VC owners       | Manage your temporary voice channels (block/unblock users, friends, rename, lock, limit)                                        |
| `/alerts add` · `list` · `remove` · `roles` · `template` · `template-reset` · `template-preview` | Manage Server   | Configure YouTube/Twitch notifications for this server                                                                          |
| `/ping`                                                                                          | Admin           | Latency check                                                                                                                   |
| `/add guild`                                                                                     | **Owner**       | Add a guild ID to the allow-list                                                                                                |
| `/removeguild`                                                                                   | **Owner**       | Remove a guild ID from the allow-list and auto-leave it                                                                         |

---

## Project layout

```
index.js              # Entry point: client, intents, command loader, interaction router
deploy-commands.js    # Registers slash commands with Discord (run via npm run deploy-commands)
ecosystem.config.cjs  # pm2 process definition (single instance — see note inside)

commands/             # One file per slash command (data + execute)
systems/              # The five systems + shared primitives
  ├─ tickets.js       #   ticket flow
  ├─ verify.js        #   verification flow
  ├─ vc.js            #   temporary voice channels
  ├─ alerts/          #   YouTube/Twitch alerts (providers, db, poller, config)
  ├─ guildConfig.js   #   per-guild settings (JSON-backed)
  ├─ whitelist.js     #   the guild allow-list (single source of truth)
  ├─ store.js         #   shared atomic JSON key/value store factory
  ├─ permissions.js   #   isOwner / isAdmin / isManager
  ├─ reply.js         #   ephemeral reply helpers
  └─ atomicJson.js    #   crash-safe JSON writes (temp file + rename)
config/               # *.config.js tunables + *.example.json state templates
data/                 # Runtime SQLite + ticket state (gitignored, created at runtime)
```

Runtime state — `.env`, `config/allowed-guilds.json`, `config/guild-config.json`, `config/vc-prefs.json`, and everything in `data/` — is gitignored. The `*.example.json` files are committed templates; the bot creates the real files on first write.

---

## Running on a VPS (pm2)

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

To update an existing deployment:

```bash
git pull
npm install
npm run deploy-commands   # only when a command's definition changed
pm2 restart multipurpose-discord-bot
```

> ⚠️ **Back up runtime state before pulling.** `config/allowed-guilds.json`, `config/guild-config.json`, `config/vc-prefs.json`, and `data/` hold live data and are gitignored. A clean checkout will not contain them; make sure your deployment keeps them across pulls.

`instances` must stay at **1** — the bot holds in-process state (alert timers, the whitelist, the SQLite handle) and is not cluster-safe.

---

## Development

```bash
npm run lint          # ESLint (real-bug focus; pre-existing nits report as warnings)
npm run format        # Prettier — format all files
npm run format:check  # Prettier — check formatting without writing
npm test              # node --test
```

---

## License

[MIT](./LICENSE) © scythe3085
