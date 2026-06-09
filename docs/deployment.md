# Deployment & Operations

How to run **multipurpose-discord-bot** in production, keep it updated, and back up the live per-server state it writes to disk.

This page assumes the bot is already installed and configured. If you haven't done that yet, start with [Setup](./setup.md). For what each in-Discord command does, see the per-system docs ([Tickets](./systems/tickets.md), [Verification](./systems/verification.md), [Voice](./systems/temp-voice.md), [Alerts](./systems/alerts.md), [Config & Whitelist](./systems/config-and-whitelist.md)).

Throughout this doc, `<deploy dir>` is the directory you cloned the bot into and `<app-name>` is the pm2 process name. The committed pm2 config names the process **`multipurpose-discord-bot`**, so unless you change it, `<app-name>` is `multipurpose-discord-bot`.

---

## Running under pm2

The bot is a single Node.js process. The repo ships a pm2 process definition at [`ecosystem.config.cjs`](../ecosystem.config.cjs):

```js
module.exports = {
  apps: [
    {
      name: 'multipurpose-discord-bot',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      time: true, // prefix log lines with timestamps
    },
  ],
};
```

Key settings:

| Field                | Value   | Why                                                         |
| -------------------- | ------- | ----------------------------------------------------------- |
| `instances`          | `1`     | **Must stay 1.** The bot is not cluster-safe (see below).   |
| `exec_mode`          | `fork`  | Single forked process, not pm2 cluster mode.                |
| `autorestart`        | `true`  | pm2 restarts the process if it crashes.                     |
| `watch`              | `false` | No file-watch auto-reload; you control restarts explicitly. |
| `max_memory_restart` | `300M`  | pm2 restarts the process if it exceeds ~300 MB RSS.         |
| `time`               | `true`  | Prefixes log lines with timestamps.                         |

Secrets are **not** in this file — environment is loaded from `.env` by `dotenv` inside `index.js` — so `ecosystem.config.cjs` is safe to commit.

### Start it

From `<deploy dir>`:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

`pm2 save` writes the current process list so pm2 can resurrect it on reboot (combine with `pm2 startup` once per machine if you want it to survive a host reboot).

### View logs

```bash
pm2 logs <app-name>          # tail live logs
pm2 logs <app-name> --lines 200   # show the last 200 lines
pm2 status                   # process state, restarts, memory, uptime
```

Because `time: true` is set, each line is timestamped.

---

## Why it is NOT cluster-safe

Do **not** raise `instances` above 1 and do **not** switch to pm2 cluster mode. The bot keeps live state inside the single process and assumes it is the only writer:

- **In-memory maps and timers.** Alert poll timers, the loaded guild whitelist, and the open `better-sqlite3` database handle all live in process memory. A second instance would run its own poll loop and **double-post** the same upload/livestream alert.
- **Single-writer JSON stores.** The JSON-backed stores ([`systems/store.js`](../systems/store.js)) load the whole file into an in-memory object once at startup and write the entire object back on every mutation. Two processes editing the same file would race: each holds a stale copy and the last writer wins, silently clobbering the other's changes.
- **Crash-safe ≠ multi-writer.** Writes go through [`systems/atomicJson.js`](../systems/atomicJson.js), which serializes to a `*.json.tmp` file and `renameSync`s it over the target. That guarantees a process kill mid-write can never leave a truncated/corrupt file — but it gives **no** protection against two processes interleaving full-file replacements. Atomic rename protects against crashes, not concurrency.

One process, one writer. Keep `instances: 1`.

---

## Update procedure

Run these from `<deploy dir>` in order. **Back up runtime state first** (see [Backups](#backups)) — a fresh checkout does not contain your live JSON state files and an unlucky pull/install can leave them stale or clobbered.

```bash
# 0. Back up live state (see Backups section) BEFORE anything else

git pull                  # fetch the new code
npm install               # sync dependencies (rebuilds better-sqlite3 if needed)
npm run deploy-commands   # re-register slash commands — only if a command changed
pm2 restart <app-name>    # restart the single process onto the new code
```

Notes:

- **`npm run deploy-commands`** (runs `node deploy-commands.js`) is only needed when a command's _definition_ changed — new/renamed command, new subcommand, changed option. Editing internal logic alone does not require it. Re-running it when nothing changed is harmless.
- **`npm install`** may recompile/refetch the `better-sqlite3` native binary; this is expected after a Node upgrade. The project requires **Node ≥ 20** (`engines` in [`package.json`](../package.json)).
- **`pm2 restart`** does a full process restart, which reloads `.env`, re-reads the JSON stores from disk, and reopens the SQLite handle.

### npm scripts reference

From [`package.json`](../package.json):

| Script                    | Command                   | Purpose                                                                                  |
| ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `npm start`               | `node index.js`           | Run the bot in the foreground (pm2 uses `index.js` directly via `ecosystem.config.cjs`). |
| `npm run deploy-commands` | `node deploy-commands.js` | Register/refresh slash commands with Discord.                                            |
| `npm test`                | `node --test`             | Run the test suite.                                                                      |
| `npm run lint`            | `eslint .`                | Lint.                                                                                    |
| `npm run format`          | `prettier --write .`      | Format all files.                                                                        |

---

## Backups

This is the part that bites self-hosters. Several files hold **live per-server data**, are written by the bot at runtime, and are **gitignored** — so they are not in the repo, and a clean checkout will not recreate them. If you lose or overwrite them, you lose your configuration.

### What to back up

**1. Runtime-mutated JSON state** (in `config/`, gitignored per [`.gitignore`](../.gitignore)):

| File                         | Holds                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `config/allowed-guilds.json` | The guild **whitelist** — which servers the bot is allowed to stay in              |
| `config/guild-config.json`   | All **per-guild settings** (ticket/verify/VC channels and roles) set via `/config` |
| `config/vc-prefs.json`       | Saved temporary-voice-channel **preferences** (locks, limits, blocklists, friends) |

These are tracked in the repo only as committed `*.example.json` **templates**; the bot creates the real files on first write. Because they are gitignored, `git pull` will not touch them in a normal deployment — but a fresh clone, a misplaced checkout, or restoring the wrong template over them will wipe live data. Back them up before every update.

**2. The alerts SQLite database** (in `data/`, gitignored):

| File                     | Holds                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| `data/alerts.sqlite`     | All YouTube/Twitch alert **subscriptions** and seen-video/stream state |
| `data/alerts.sqlite-wal` | Write-ahead log sidecar (the DB runs in WAL mode)                      |
| `data/alerts.sqlite-shm` | Shared-memory sidecar                                                  |

The database uses WAL journaling, so recent writes may live in the `-wal` sidecar. To get a clean, consistent snapshot, prefer a SQLite-aware backup over a raw file copy:

```bash
# Consistent online backup (works while the bot is running):
sqlite3 data/alerts.sqlite ".backup 'backups/alerts-$(date +%F).sqlite'"
```

If you copy the raw file instead, copy **all three** (`alerts.sqlite`, `alerts.sqlite-wal`, `alerts.sqlite-shm`) together so the WAL is preserved. The `data/` directory and the `.sqlite*` files are recreated automatically on startup if missing, but recreating them gives you an **empty** database — back them up to keep your subscriptions.

### Suggested backup step before updates

```bash
# from <deploy dir>, before `git pull`
mkdir -p backups
cp config/allowed-guilds.json config/guild-config.json config/vc-prefs.json backups/ 2>/dev/null
sqlite3 data/alerts.sqlite ".backup 'backups/alerts-$(date +%F).sqlite'"
```

> Tip: keep `config/*.json` (the live state) and `data/` **outside** the path a `git pull`/redeploy can disturb, or restore them from backup immediately after pulling. Whatever your workflow, confirm these files survive each update.

---

## Restart / recovery quick reference

| Situation                       | What to do                                                           |
| ------------------------------- | -------------------------------------------------------------------- |
| Deployed new code               | Run the [Update procedure](#update-procedure).                       |
| Bot crashed                     | pm2 `autorestart` brings it back; check `pm2 logs <app-name>`.       |
| Memory creep                    | `max_memory_restart: 300M` auto-restarts; investigate via logs.      |
| Config looks reset after a pull | A clobbered/missing `config/*.json` — restore from your backup.      |
| Lost all alert subscriptions    | An empty `data/alerts.sqlite` was recreated — restore the DB backup. |

---

## Related docs

- [Setup](./setup.md) — install, `.env`, first run, inviting the bot
- [Config & Whitelist](./systems/config-and-whitelist.md) — `/config`, `/add`, `/removeguild`
- [Alerts](./systems/alerts.md) — YouTube/Twitch subscriptions stored in the SQLite DB
