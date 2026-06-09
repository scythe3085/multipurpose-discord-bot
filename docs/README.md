# Documentation

Full guide to **multipurpose-discord-bot** — a single self-hostable discord.js v14 bot
bundling five per-guild systems (tickets, verification, temporary voice channels,
YouTube/Twitch alerts, and configuration + a guild whitelist).

New here? Read the [Overview](./overview.md), then follow the [Setup Guide](./setup.md).

## Getting started

| Doc                                        | What it covers                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Overview & Architecture](./overview.md)   | What the bot is for, the five systems, and how it is wired together (process model, interaction router, persistence, intents)             |
| [Setup Guide](./setup.md)                  | First-time install: prerequisites, the Discord application, `.env` walkthrough, registering commands, first run, and per-server `/config` |
| [Deployment & Operations](./deployment.md) | Running under pm2 on a VPS, the update procedure, and backing up runtime state                                                            |

## Systems

| System                             | Doc                                                                  |
| ---------------------------------- | -------------------------------------------------------------------- |
| 🎫 Tickets                         | [systems/tickets.md](./systems/tickets.md)                           |
| ✅ Verification                    | [systems/verification.md](./systems/verification.md)                 |
| 🔊 Temporary voice channels        | [systems/temp-voice.md](./systems/temp-voice.md)                     |
| 📺 YouTube / Twitch alerts         | [systems/alerts.md](./systems/alerts.md)                             |
| 🛡️ Configuration & guild whitelist | [systems/config-and-whitelist.md](./systems/config-and-whitelist.md) |

---

Per-server behaviour (channels, roles) is configured **live in Discord** with `/config`,
not through environment variables — `.env` only holds credentials and the owner ID.
See [Configuration & Whitelist](./systems/config-and-whitelist.md).
