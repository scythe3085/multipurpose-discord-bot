# Temporary Voice Channels

A "join-to-create" voice system. A member joins one designated hub voice channel and the bot spawns a personal voice channel for them in a configured category, makes them the owner, moves them in, and posts a control panel in the channel's built-in text chat. The channel is auto-deleted once it empties.

All per-server wiring is done in Discord with [`/config`](./config-and-whitelist.md) — there are no env vars for this system. The only static knob lives in `config/vc.config.js`.

> Permissions: the bot must be able to **Manage Channels** (create/rename/set-limit/delete and edit per-channel permission overwrites), **Move Members**, and **Mute Members** (for `/voice mute`). Its role must sit **above** the members it manages, or overwrite/mute/disconnect actions will fail.

---

## How it works

1. A member joins the configured **Join-to-Create** voice channel.
2. The bot creates a new voice channel under the configured **VC category**, inheriting the category's permissions, then layers on the owner's overwrites (`Connect`, `ViewChannel`, `ManageChannels`).
3. The member is moved into the new channel.
4. A Components V2 **control panel** is sent into the new channel's text chat.
5. When the last person leaves, the channel is deleted (after a short delay).

The bot tracks each managed channel in memory: owner, co-owners, per-channel ban list, the panel message ID, and the current privacy mode. State is restored from Discord on restart (see [Persistence & restart](#persistence--restart)).

---

## Server setup

Two settings are required. Set them via [`/config`](./config-and-whitelist.md) (admin only):

| Setting               | Subcommand                                    | Stored key         | Channel type  |
| --------------------- | --------------------------------------------- | ------------------ | ------------- |
| Join-to-Create hub VC | `/config set-join-vc channel:<voice channel>` | `joinToCreateVcId` | Voice channel |
| Category for temp VCs | `/config set-vc-category category:<category>` | `vcCategoryId`     | Category      |

Or configure both (plus the other systems) in one shot with `/config quick-setup` using its optional `join_vc` and `vc_category` options.

`/config show` lists the current Voice settings and warns if either is missing.

If a member joins the hub before `vcCategoryId` is set, the bot DMs them telling an admin to run `/config quick-setup` or `/config set-vc-category`, and creates nothing.

### Static config

`config/vc.config.js` exposes a single value:

| Key                    | Default | Meaning                                                                                                                                                                                                                       |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATION_COOLDOWN_MS` | `10000` | Minimum time (ms) a user must wait between creating temp VCs. If they retry too soon they get a DM telling them to wait. The cooldown is cleared immediately when their VC is deleted, so re-joining the hub works instantly. |

---

## The control panel

The panel is a Components V2 container posted in the temp channel's text chat. It shows the channel name, privacy badge, live member count / limit, owner (with avatar), the member list (owner tagged 👑, co-owners 🤝), the co-owner and ban lists, and an auto-save status line. Member mentions never ping (`allowedMentions: { parse: [] }`).

Only a **controller** can use the panel's actions. A controller is the **owner**, any **co-owner**, or a guild **Administrator**. Non-controllers get an ephemeral "not allowed" reply.

### Buttons

| Button                | customId prefix      | Action                                                                                                     |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| ✏️ Rename             | `vc_rename`          | Opens a modal (`vc_rename_modal`) to set a new channel name (max 100 chars).                               |
| Privacy (cycles)      | `vc_privacy_cycle`   | Cycles privacy: **Public → Friends-only → Private → Public**. Button color/label reflect the current mode. |
| 👥 Limit              | `vc_limit`           | Opens a modal (`vc_limit_modal`) to set the user limit (`0`–`99`, `0` = unlimited).                        |
| 🗑 Delete             | `vc_delete`          | Deletes the channel immediately.                                                                           |
| 🔄 Refresh            | `vc_refresh`         | Re-renders the panel in place.                                                                             |
| 💾 Auto-save · ON/OFF | `vc_autosave_toggle` | **Owner only.** Toggles the owner's saved profile (see [Auto-save profiles](#auto-save-profiles)).         |

A legacy `vc_lock_toggle` button (from older panels) is still handled: it just refreshes the panel and tells the user the lock toggle was replaced by the 3-state Privacy button.

### Select menus

| Menu                | customId prefix     | Options                                                                             |
| ------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| 👤 Manage members   | `vc_member_manage`  | `ban:<id>` for each non-owner present, `unban:<id>` for each currently banned user. |
| 🤝 Manage co-owners | `vc_coowner_manage` | `add:<id>` for each non-owner present, `remove:<id>` for each current co-owner.     |

Older split menus `vc_member_ban` / `vc_member_unban` are still handled for stale panels.

**Ban** = blocked from _this VC only_. The bot sets `Connect: false` (keeping `ViewChannel`) and disconnects them if present. They can still use other channels. **Unban** clears that overwrite. (For a persistent, cross-VC block, use `/voice block` instead.)

**Co-owner** add grants `Connect`/`ViewChannel` so they can always join, even when locked, and makes them a controller. Remove clears those overwrites.

---

## Privacy modes

Cycled with the panel's Privacy button. Privacy is enforced by editing only the overwrites the bot manages — it never touches role-level permissions or explicit `/voice invite` allows.

| Mode            | `@everyone` Connect | Who can join                                                    | Accent |
| --------------- | ------------------- | --------------------------------------------------------------- | ------ |
| 🔓 Public       | allowed             | Anyone with category access                                     | Green  |
| 🤝 Friends-only | denied              | Owner, co-owners, and the owner's [friends list](#friends-list) | Yellow |
| 🔒 Private      | denied              | Owner and co-owners only (friends are **not** auto-allowed)     | Red    |

When locked (friends/private), owner and co-owners always get an explicit `Connect`/`ViewChannel` allow. The per-VC ban list always wins over the friends list. If the owner has auto-save on, cycling privacy also saves the new mode into their profile.

---

## `/voice` commands

Extra controls that aren't on the panel. All replies are ephemeral. Commands that act on a live VC require you to be **inside** the managed temp VC, and most require controller rights.

| Subcommand             | Options | What it does                                                                                                                                                                                                  |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/voice block`         | `user`  | Adds a user to your **persistent** per-server VC blocklist. Applies to every temp VC you own now and in future. If you currently own a VC, they're banned and disconnected from it immediately.               |
| `/voice unblock`       | `user`  | Removes a user from your persistent blocklist; clears the ban on your current VC if present.                                                                                                                  |
| `/voice mute`          | `user`  | **VC-only** server-mute of a user in your current temp VC. Auto-clears when they leave that VC or next join any voice channel. Requires you and the target to be in the VC, and the bot to have Mute Members. |
| `/voice unmute`        | `user`  | Clears a bot-applied VC-only mute. If the target isn't connected, it's marked pending and auto-clears on their next voice join.                                                                               |
| `/voice claim`         | —       | Claim ownership of the temp VC you're in **if the original owner has left it**. Transfers owner and grants you `ManageChannels`. Fails if the original owner is still present.                                |
| `/voice invite`        | `user`  | Grants a user `Connect`/`ViewChannel` on your current temp VC so they can join even if it's locked.                                                                                                           |
| `/voice friend-add`    | `user`  | Adds a user to your **persistent** per-server friends list. If you own a live Friends-only VC, they get Connect immediately. Can't friend yourself or a bot.                                                  |
| `/voice friend-remove` | `user`  | Removes a user from your friends list. Clears their friend allow on any live VC you own, and disconnects them if they were only there via Friends-only access.                                                |
| `/voice friend-list`   | —       | Shows your friends list for this server.                                                                                                                                                                      |

### Block vs. ban (panel)

- **Panel ban** (`vc_member_manage`) is tied to _one_ channel and lives in memory only.
- **`/voice block`** is persistent and per-server: a blocked user is auto-banned on creation of _any_ future temp VC you own. The block list is also applied automatically when a new VC spawns.

### Friends list

A per-server allowlist that bypasses **Friends-only** privacy (it does **not** open up Private mode). Stored persistently. Banned users are never let in by the friends list — the ban always wins.

---

## Auto-save profiles

Each owner can opt into saving their preferred VC setup, toggled with the panel's **💾 Auto-save** button (owner only). Default is **off**.

When auto-save is **on**:

- Renaming, changing the user limit, or cycling privacy patches the saved profile.
- The next time you create a VC from the hub, the bot applies your saved **name**, **user limit**, and **privacy mode**.

Toggling it on for the first time snapshots the current name/limit/privacy as the starting profile. Toggling it off keeps the saved profile so flipping it back on restores your settings. Profiles, blocklists, and friends lists are all stored per-guild/per-user in `config/vc-prefs.json` (gitignored runtime state; see the `*.example.json` templates).

---

## Persistence & restart

The bot holds live VC state in memory, so on startup it reconciles against Discord for every guild:

- It scans all voice channels in each guild's configured VC category.
- A channel is treated as bot-managed if a **member** overwrite grants `ManageChannels` (that member is inferred as the owner).
- **Empty** managed channels are auto-deleted.
- **Occupied** ones have their tracking restored. Co-owners and ban lists are **not** recovered (they reset to empty). Privacy is inferred from the current overwrites: if `@everyone` is denied Connect and a friend has an explicit allow, it's restored as **Friends-only**; if `@everyone` is denied with no friend allow, **Private**; otherwise **Public**. If the inference is wrong, just cycle the Privacy button once.

The panel message ID is not persisted across restart, so the old panel becomes inert; use **🔄 Refresh** (or any panel action) to repost/re-render it.

---

## Cleanup

- When someone leaves a tracked temp VC, the bot waits ~2 seconds and deletes the channel if it's now empty, untracks it, and clears the owner's creation cooldown.
- **🗑 Delete** on the panel deletes immediately.
- On restart, empty managed channels in the VC category are swept (see above).

---

## Related docs

- [Configuration & Whitelist](./config-and-whitelist.md) — `/config` subcommands and stored keys
- [Setup](../setup.md) — env vars, install, and running the bot
- [Tickets](./tickets.md) · [Verification](./verification.md) · [Alerts](./alerts.md)
