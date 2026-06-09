# Configuration & Guild Whitelist

Two related subsystems control who the bot serves and how it behaves on each server:

1. **`/config`** — per-guild settings (channels and roles) that every other system reads. Each guild is fully isolated; nothing is shared across servers.
2. **The guild whitelist** — an owner-only allow-list that decides which Discord servers the bot is permitted to join at all. The bot auto-leaves any server not on the list.

All per-server setup happens **in Discord** via `/config`, not through environment variables. The only operator-level secret involved here is `OWNER_ID` in `.env` (see [Setup](../setup.md)).

---

## 1. `/config` — per-guild configuration

### Permissions

`/config` is built with `setDefaultMemberPermissions(PermissionFlagsBits.Administrator)`, so Discord hides it from non-admins in the slash-command picker. `execute()` **also** re-checks `interaction.member.permissions.has(PermissionFlagsBits.Administrator)` and rejects non-admins with `🚫 Only administrators can use this command.`. Both gates are guild Administrator — there is no owner requirement for `/config`. All replies are ephemeral.

### Subcommands

| Subcommand             | Purpose                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `show`                 | Show the current configuration for this server, grouped into Tickets / Verification / Voice, plus a setup-warnings or all-good footer. |
| `quick-setup`          | Guided one-shot setup that writes every field at once.                                                                                 |
| `set-ticket-log`       | Set the ticket log channel.                                                                                                            |
| `set-transcript-log`   | Set the transcript channel (optional; if unset, transcripts are disabled).                                                             |
| `set-owner-role`       | Set the ticket "Owner" contact role.                                                                                                   |
| `set-twitch-mod-role`  | Set the ticket "Twitch Mod" contact role.                                                                                              |
| `set-discord-mod-role` | Set the ticket "Discord Mod" contact role.                                                                                             |
| `set-verified-role`    | Set the role granted on successful verification.                                                                                       |
| `set-verify-log`       | Set the verification log channel.                                                                                                      |
| `set-join-vc`          | Set the Join-to-Create voice channel (must be a voice channel).                                                                        |
| `set-vc-category`      | Set the category where temporary VCs are created (must be a category).                                                                 |

The nine `set-*` subcommands are generated from a single `SET_FIELDS` table in `commands/config.js`; both the command builder and the dispatch read from it, so adding a configurable field is a one-line change. `show` and `quick-setup` are bespoke because they touch every field at once.

### `quick-setup` options

`quick-setup` is the fastest way to configure a fresh server. Two options are **required**; the rest are optional.

| Option             | Required | Writes to key                                |
| ------------------ | -------- | -------------------------------------------- |
| `ticket_log`       | ✅       | `ticketLogChannelId`                         |
| `verified_role`    | ✅       | `verifiedRoleId`                             |
| `transcript_log`   | —        | `transcriptChannelId`                        |
| `owner_role`       | —        | `ticketOwnerRoleId`                          |
| `twitch_mod_role`  | —        | `ticketTwitchModRoleId`                      |
| `discord_mod_role` | —        | `ticketDiscordModRoleId`                     |
| `verify_log`       | —        | `verifyLogChannelId`                         |
| `join_vc`          | —        | `joinToCreateVcId` (must be a voice channel) |
| `vc_category`      | —        | `vcCategoryId` (must be a category)          |

Omitted optional options are written as `null` (i.e. `quick-setup` clears any previously-set value for the fields it does not receive). Use the individual `set-*` subcommands afterward to fill in or change one field at a time without touching the others.

Channel-type validation: `join_vc` must be a voice channel and `vc_category` must be a category, both in `quick-setup` and in `set-join-vc` / `set-vc-category`; a wrong type is rejected before anything is saved.

### Config keys and which system reads them

`/config` persists these keys per guild. The right-hand columns show which system consumes each key and how a system reads it (via the helper accessors in `systems/guildConfig.js`).

| Config key               | Set by                                | Read by                                                                                                  | Notes / fallback                                                                                                                                                |
| ------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ticketLogChannelId`     | `set-ticket-log`, `quick-setup`       | Tickets (`getTicketConfig` → `logChannelId`), Verification (`getVerifyConfig` → `logChannelId` fallback) | Ticket log. Also used as the verification log fallback when `verifyLogChannelId` is unset.                                                                      |
| `transcriptChannelId`    | `set-transcript-log`, `quick-setup`   | Tickets (`getTicketConfig` → `transcriptChannelId`, and `logChannelId` fallback)                         | Where full transcripts go. **No fallback to the log channel** — if unset, transcripts are skipped so a private conversation never lands in a general staff-log. |
| `ticketOwnerRoleId`      | `set-owner-role`, `quick-setup`       | Tickets (`getTicketConfig` → `ownerRoleId`)                                                              | Role pinged for "Contact Owner" tickets.                                                                                                                        |
| `ticketTwitchModRoleId`  | `set-twitch-mod-role`, `quick-setup`  | Tickets (`getTicketConfig` → `twitchModRoleId`)                                                          | Role pinged for "Contact Twitch Mod" tickets.                                                                                                                   |
| `ticketDiscordModRoleId` | `set-discord-mod-role`, `quick-setup` | Tickets (`getTicketConfig` → `discordModRoleId`)                                                         | Role pinged for "Contact Discord Mod" tickets.                                                                                                                  |
| `verifiedRoleId`         | `set-verified-role`, `quick-setup`    | Verification (`getVerifyConfig` → `verifiedRoleId`)                                                      | Role granted on successful verification.                                                                                                                        |
| `verifyLogChannelId`     | `set-verify-log`, `quick-setup`       | Verification (`getVerifyConfig` → `logChannelId`)                                                        | Verification log. Falls back to `ticketLogChannelId` if unset.                                                                                                  |
| `joinToCreateVcId`       | `set-join-vc`, `quick-setup`          | Temporary VCs (`getVcConfig` → `joinToCreateVcId`)                                                       | The "Join-to-Create" voice channel.                                                                                                                             |
| `vcCategoryId`           | `set-vc-category`, `quick-setup`      | Temporary VCs (`getVcConfig` → `vcCategoryId`)                                                           | Category where temp VCs are created.                                                                                                                            |

See [Tickets](./tickets.md), [Verification](./verification.md), and [Temporary Voice Channels](./temp-voice.md) for how each system uses these values.

### Setup warnings (`getConfigStatus`)

`show` and `quick-setup` both run a health check (`getConfigStatus` in `systems/guildConfig.js`) and append the results. A guild is flagged when:

- `ticketLogChannelId` is not set → "Ticket log channel is not set."
- `verifiedRoleId` is not set → "Verified role is not set."
- `joinToCreateVcId` is not set → "Join-to-Create VC is not set."
- `vcCategoryId` is not set → "VC category is not set."
- **none** of `ticketOwnerRoleId` / `ticketTwitchModRoleId` / `ticketDiscordModRoleId` is set → "No ticket contact roles are configured."

If the list is empty it shows "Everything essential looks configured!". These are advisory only; unconfigured systems simply stay inactive for that guild.

### The config store (`guildConfig.js` on `store.js`)

Per-guild config lives in a single JSON file, `config/guild-config.json`, managed by `systems/guildConfig.js` (built on the shared `systems/store.js` key/value store).

- The file is keyed by guild ID. Each guild's value is an object with all nine keys above (any unset key is `null`).
- `getGuildConfig(guildId)` lazily creates a fully-null entry for a guild the first time it's read (`ensureGuild`), so missing guilds never throw.
- `updateGuildConfig(guildId, patch)` shallow-merges a patch and saves.
- The store (`createJsonStore`) loads the whole file into memory once at startup and writes back **atomically** (temp file + rename via `writeJsonAtomic`) on every mutation, so a crash mid-write cannot corrupt the file. A non-object root (array/primitive) is treated as empty `{}`.

The runtime file is gitignored. A template ships as `config/guild-config.example.json` (contents: `{}`). On first run the bot creates entries on demand, so you can start from the empty template — you do not need to hand-edit it.

---

## 2. Guild whitelist (owner-only)

The whitelist decides which Discord servers the bot will operate in. It is enforced both reactively (when the bot is invited) and through owner commands.

### Source of truth (`whitelist.js`)

`systems/whitelist.js` owns the allow-list: a JSON **array of guild-ID strings** in `config/allowed-guilds.json`. It keeps one in-memory array that `index.js`, `/add`, and `/removeguild` all share, so every read and write agrees within the single bot process. (Previously each read the file independently, which let an add-then-remove in the same process resurrect or drop entries.)

| Function             | Behavior                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| `isAllowed(guildId)` | True if the (stringified) ID is in the list.                              |
| `add(guildId)`       | Adds an ID; returns `false` if already present. Persists atomically.      |
| `remove(guildId)`    | Removes an ID; returns `false` if it wasn't present. Persists atomically. |
| `list()`             | Returns a snapshot copy of the current IDs.                               |
| `reload()`           | Re-reads the file from disk (e.g. after editing it out of band).          |

IDs are de-duped and normalized to strings on load; a missing file (`ENOENT`) or a non-array file is treated as an empty list. Like the config store, writes are atomic.

The runtime file is gitignored. A template ships as `config/allowed-guilds.example.json` (contents: `[]`). You can either pre-seed it with your guild IDs before first run, or add them at runtime with `/add guild`.

### Auto-leave on join (`guildCreate` in `index.js`)

When the bot is added to any server, the `guildCreate` handler checks `whitelist.isAllowed(guild.id)`:

- **Not allowed** → it logs `Joined unauthorized guild … — leaving.` and immediately calls `guild.leave()`.
- **Allowed** → it logs `Joined allowed guild …` and stays.

So a guild must be on the allow-list **before** the bot is invited, otherwise it leaves on the way in. Add the ID with `/add guild` (from a server where the owner is already present) or pre-seed `config/allowed-guilds.json`, then invite the bot.

### `/add guild` — allow a guild ID

```
/add guild id:<guild ID>
```

Adds a guild ID to the allow-list. The `id` option is validated against a basic snowflake pattern (`^\d{10,25}$`); a malformed value is rejected with a warning. If the ID is already present you get an informational "already in the allowed list" reply; otherwise it confirms the add and notes that new invites to that guild will be accepted.

> The command is named `/add` with a single `guild` subcommand (its top-level description is "Owner-only tools").

### `/removeguild` — remove a guild ID and leave

```
/removeguild guild_id:<guild ID>
```

Removes a guild ID from the allow-list. If the bot is **currently in** that guild (`client.guilds.cache`), it then calls `targetGuild.leave()` and reports whether the leave succeeded. Removing an ID that wasn't on the list returns an informational reply and does nothing else.

### Owner gate (`isOwner` + `setDefaultMemberPermissions`)

Both `/add` and `/removeguild` use **two** layers of protection:

1. **Discord-side visibility:** `setDefaultMemberPermissions('0')` — no default permissions, so the commands are hidden from everyone except server admins in the slash picker. This is _only_ a UI filter.
2. **The real gate — `isOwner`:** `execute()` calls `isOwner(interaction.user.id)` (from `systems/permissions.js`) and returns the standard ephemeral denial (`⚠️ You are not allowed to use this command.`) if it fails.

`isOwner` compares the caller's ID against `OWNER_ID` from the environment (`process.env.OWNER_ID`, trimmed):

```js
function isOwner(userId) {
  const owner = getOwnerId();
  return owner !== '' && String(userId) === owner;
}
```

**Important:** if `OWNER_ID` is **unset or blank**, `getOwnerId()` returns `''` and `isOwner` returns `false` for _everyone_ — there is no fallback owner. In that state nobody can run `/add` or `/removeguild`, and the whitelist can only be changed by editing `config/allowed-guilds.json` directly (followed by a restart, or `whitelist.reload()`). Always set `OWNER_ID` in `.env`. See [Setup](../setup.md) for the env vars.

Because the Discord-side gate is admin-only and the authoritative gate is `isOwner`, the bot owner must also be a guild administrator wherever they run these commands.

---

## Quick reference

| Concern                   | Where it lives                                                                |
| ------------------------- | ----------------------------------------------------------------------------- |
| Per-guild config command  | `commands/config.js`                                                          |
| Config store / accessors  | `systems/guildConfig.js` (on `systems/store.js`)                              |
| Config runtime file       | `config/guild-config.json` (template: `config/guild-config.example.json`)     |
| Whitelist logic           | `systems/whitelist.js`                                                        |
| Whitelist runtime file    | `config/allowed-guilds.json` (template: `config/allowed-guilds.example.json`) |
| Auto-leave handler        | `guildCreate` in `index.js`                                                   |
| Owner commands            | `commands/add.js`, `commands/removeguild.js`                                  |
| Owner / permission checks | `systems/permissions.js` (`isOwner`, `isAdmin`, `isManager`)                  |

Related docs: [Setup](../setup.md) · [Tickets](./tickets.md) · [Verification](./verification.md) · [Temporary Voice Channels](./temp-voice.md) · [YouTube/Twitch Alerts](./alerts.md)
