# Ticket System

A staff-contact system built around a public **panel**, per-department **private threads**, and a single self-updating **Components V2** control card. Members pick a department, fill in a short form, and the bot spins up a private thread that pings the matching staff role. Staff can claim, add users, and close (with a saved transcript); closed tickets can be reopened.

See also: [Setup](../setup.md) · [Configuration & Whitelist](./config-and-whitelist.md) · [Verification](./verification.md) · [Temporary Voice Channels](./temp-voice.md)

---

## Source files

| File                          | Responsibility                                                        |
| ----------------------------- | --------------------------------------------------------------------- |
| `commands/ticket.js`          | The `/ticket` slash command (`panel`, `close`).                       |
| `systems/tickets/index.js`    | Public facade: slash router + component/modal router.                 |
| `systems/tickets/ui.js`       | Pure builders — panel, modals, the V2 ticket container.               |
| `systems/tickets/handlers.js` | The full lifecycle: open, claim, add user, close, reopen, transcript. |
| `systems/tickets/helpers.js`  | Cooldown tracking, log helper, staff/department permission checks.    |
| `systems/ticketState.js`      | Per-thread state persisted to `data/tickets.json`.                    |
| `config/tickets.config.js`    | Static departments, cooldown, panel copy, status colors.              |
| `systems/guildConfig.js`      | Per-guild channel/role IDs (set in Discord via `/config`).            |

---

## Quick start

1. **Configure the guild** (admin, in Discord) — set at least the ticket log channel and the department roles. Use either `/config quick-setup` or the individual setters. See [Configuration keys](#configuration-keys).
2. **Post the panel** — run `/ticket panel` in the channel where members should open tickets (admin only).
3. Members click a department button, fill in the form, and a private thread is created.

> The bot needs permission to create **private threads** and manage threads (lock/archive/add members) in the channel where the panel lives.

---

## Commands

`/ticket` has two subcommands (`commands/ticket.js`):

| Subcommand      | Who           | What it does                                                                                                     |
| --------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/ticket panel` | Administrator | Posts the public ticket panel in the current channel. Non-admins get `🚫 Only admins can post the ticket panel.` |
| `/ticket close` | Ticket staff  | Slash equivalent of clicking **Close** — opens the same confirmation modal.                                      |

Everything else (open, claim, add user, close, reopen) is driven by **buttons, select menus, and modals** on the panel and inside the thread — there are no other slash subcommands.

---

## Lifecycle

### 1. The panel

`/ticket panel` calls `sendTicketPanel()` which builds one **Components V2 container** (`MessageFlags.IsComponentsV2`) with:

- A title and intro (`PANEL.title` / `PANEL.intro` in the config).
- One section per department (label + `panelDescription`).
- One button per department, each with custom ID `ticket_open_panel:<departmentKey>` and the department's configured `buttonStyle`.

The three built-in departments are defined statically in `config/tickets.config.js`:

| Key                   | Button label           | For                                     |
| --------------------- | ---------------------- | --------------------------------------- |
| `contact_owner`       | 👑 Contact Owner       | Important / personal / serious issues   |
| `contact_twitch_mod`  | 📺 Contact Twitch Mod  | Stream issues, chat reports, bans, etc. |
| `contact_discord_mod` | 🛡️ Contact Discord Mod | Rule breaks, support, general help      |

Each department has its own `formQuestions` (a `subject` short field and a `details` paragraph field), accent `color`, and `buttonStyle`.

### 2. Opening a ticket (button → modal)

Clicking a department button (`handlePanelButton`):

1. Checks the **cooldown** — `COOLDOWN_MS` (5 minutes) between opens per user. **Staff bypass the cooldown.** A user on cooldown gets an ephemeral `⏳ … wait Ns` message.
2. Shows a modal (`ticket_modal:<departmentKey>`) built from the department's `formQuestions`, plus an **optional file upload** field (`ticket_files`, 0–5 files, not required). The file field is wrapped in a `LabelBuilder` because Discord rejects `FileUploadBuilder` inside a modal action row.

On submit (`handleTicketModal`):

- The handler **defers** the reply immediately (ephemeral) — creating the thread, sending the card, and re-uploading files routinely exceed the 3-second modal ack window.
- The cooldown is marked (staff excluded).
- A **private thread** is created in the panel's channel, named `ticket-<sanitizedUsername>` (alphanumeric only, capped at 90 chars), `autoArchiveDuration: 1440` (24h).
- The bot resolves the department's staff role(s) for this guild and posts a ping line: `@Role · new ticket from @user` (falls back to `@here` if no role is configured). The opener is also added via `allowedMentions`.
- One merged **V2 container** (the control card) is sent into the thread with the Q/A, status, and action buttons. Its message ID is persisted so later edits target it.
- If any answer is too long for the V2 4000-char text budget (over ~1500 chars per field), the truncated answer shows in the card and the **full text is posted as a plain follow-up message**.
- Any modal-attached files are re-uploaded into the thread as their own message (falling back to a list of links if re-upload fails).
- A log embed (`🆕 <department label>`) is sent to the ticket log channel.
- The ephemeral reply is edited to `✅ Your ticket has been created: <thread>`.

### 3. The control card (Components V2)

`buildTicketContainer(state, opts)` renders the entire ticket — Q/A, status line, a hint, and action buttons — into a **single V2 message** that is **edited in place** on every state change. The accent color reflects status:

| State            | Accent (`STATUS_COLORS`) |
| ---------------- | ------------------------ |
| Open · unclaimed | `OPEN_UNCLAIMED` (green) |
| Open · claimed   | `OPEN_CLAIMED` (yellow)  |
| Closed           | `CLOSED` (red)           |

While open, the buttons are **Claim**, **Add user**, and **Close**. When closed, they collapse to a single **Reopen** button. The ping line is only included on the very first send; edits omit it and set `allowedMentions: { parse: [] }` so claims/closes don't re-ping staff.

> **Legacy cards:** tickets created before the merged-container layout have no persisted state on disk. The code keeps `buildOpenControlPanel` / `buildClosedControlPanel` and dual custom-ID parsing so those old messages still work.

### 4. Staff actions

#### Claim / release (`handleClaim`)

- Custom ID `ticket_claim:<dept>` (unclaimed) or `ticket_claim:<dept>:<claimerId>` (claimed).
- Any **ticket staff** may claim. A claimed ticket can only be released by the claimer (others get "already claimed by …").
- Claiming edits the card to yellow and logs `👋 Ticket claimed`. Releasing edits it back to green and is **not** logged (low signal).
- Claiming a closed ticket is rejected — reopen first.

#### Add user (`handleAddUserButton` → `handleAddUserSelect`)

- Custom ID `ticket_addmember_btn` (button) → ephemeral user-select menu `ticket_addmember_select`.
- Staff-only. Picks one member and adds them to the private thread (`channel.members.add`). Bots cannot be added.
- Logs `➕ User added to ticket`.

#### Close (`handleCloseButton` → `handleCloseModal`)

- Custom ID `ticket_close` / `ticket_close:<dept>`. Staff-only. Also reachable via `/ticket close`.
- Opens a confirm modal (`ticket_close_modal`) with an optional **reason** field (`ticket_close_reason`, max 500 chars). Clicking Close on an already-closed ticket is short-circuited.
- On submit, the close flow:
  1. Unarchives the thread if it auto-archived between showing and submitting the modal.
  2. Defers (transcript building takes seconds).
  3. **Builds a transcript** (see below) and sends it as a `.txt` attachment to the **transcript channel** (if configured). If no transcript channel is set, the transcript is **skipped** — it is never sent to the general log channel.
  4. Logs `✅ Ticket closed` (with reason, truncated to 500 chars) to the ticket log channel.
  5. Edits the control card to the closed (red) state with closer + reason, swapping the buttons for **Reopen**.
  6. **Locks** the thread (so the opener and added users can't keep typing), then **archives** it ~1.5s later.

#### Reopen (`handleReopen`)

- Custom ID `ticket_reopen` / `ticket_reopen:<dept>`. Found on closed cards.
- **Restricted to the same department role(s) that get pinged on open** (admins always allowed). This is stricter than the other actions, which any staff role can perform. If the department can't be determined (legacy ticket), it falls back to general staff.
- Unarchives and **unlocks** the thread, clears the closed/claimed flags, and rebuilds the card to the open state. Logs `🔓 Ticket reopened`.

### 5. Transcripts

`buildTranscript(thread)` paginates the full thread history (100 messages at a time), sorts chronologically, and writes a plain-text log. Each message becomes:

```
[2026-06-08T12:34:56.000Z] user#0 (123456789012345678) [edited]:
  message line 1
  message line 2
  📎 screenshot.png (10240 bytes) — https://cdn.discordapp.com/...
  🔗 Embed: "Title" — Description
     • Field name: Field value
```

The result is uploaded as `transcript-<thread name>.txt` to the configured transcript channel.

---

## Permissions model

Defined in `systems/tickets/helpers.js`:

- **Ticket staff** (`isTicketStaff`) = anyone with the Administrator permission **or** any of the three configured ticket roles (owner / Twitch mod / Discord mod). Ticket staff can claim, add users, and close.
- **Department staff** (`isDeptStaff`) = Administrator, or a member holding the **specific** role mapped to that ticket's department. Used only to gate **Reopen**. If a guild has no role configured for that department, it falls back to general ticket staff so the feature still works pre-setup.

Department → role mapping (`getDepartmentRolesForGuild`):

| Department key        | Guild-config role key    |
| --------------------- | ------------------------ |
| `contact_owner`       | `ticketOwnerRoleId`      |
| `contact_twitch_mod`  | `ticketTwitchModRoleId`  |
| `contact_discord_mod` | `ticketDiscordModRoleId` |

These same roles are what get pinged when a ticket of that department is opened.

---

## Configuration keys

Per-server settings live in `config/guild-config.json` and are set **in Discord** via `/config` (admin only) — never in `.env`. Run `/config show` to see the current values and any setup warnings.

| Guild-config key         | `/config set-*` subcommand     | `quick-setup` option          | Purpose                                                                                                                           |
| ------------------------ | ------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ticketLogChannelId`     | `/config set-ticket-log`       | `ticket_log` (required)       | Channel for ticket log embeds (opened/claimed/closed/etc.).                                                                       |
| `transcriptChannelId`    | `/config set-transcript-log`   | `transcript_log` (optional)   | Channel that receives the full close transcript. **If unset, transcripts are disabled** — they are never sent to the log channel. |
| `ticketOwnerRoleId`      | `/config set-owner-role`       | `owner_role` (optional)       | Role pinged for / allowed to reopen 👑 Contact Owner tickets.                                                                     |
| `ticketTwitchModRoleId`  | `/config set-twitch-mod-role`  | `twitch_mod_role` (optional)  | Role pinged for / allowed to reopen 📺 Contact Twitch Mod tickets.                                                                |
| `ticketDiscordModRoleId` | `/config set-discord-mod-role` | `discord_mod_role` (optional) | Role pinged for / allowed to reopen 🛡️ Contact Discord Mod tickets.                                                               |

Notes:

- The **log channel** (`logTicket`) resolves to `ticketLogChannelId`, falling back to `transcriptChannelId` if the log channel isn't set.
- A guild with **none** of the three ticket roles set produces a `/config show` warning (`No ticket contact roles are configured.`), and ticket pings fall back to `@here`.

### Static config (`config/tickets.config.js`)

These are code-level and apply to **all** guilds — edit the file and redeploy to change them:

| Key             | Default                 | Meaning                                                                         |
| --------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `COOLDOWN_MS`   | `5 * 60 * 1000` (5 min) | Per-user cooldown between opening tickets (staff bypass it).                    |
| `departments`   | 3 departments           | Department keys, labels, panel copy, colors, button styles, and form questions. |
| `STATUS_COLORS` | green / yellow / red    | Accent colors for unclaimed / claimed / closed cards.                           |
| `PANEL`         | title + intro           | Header text on the public panel.                                                |

---

## Custom ID namespace (`ticket_`)

All ticket interactions are routed by `handleTicketComponentOrModal` in `systems/tickets/index.js`:

| Custom ID                                                                  | Component               | Handler               |
| -------------------------------------------------------------------------- | ----------------------- | --------------------- |
| `ticket_open_panel:<dept>`                                                 | Panel department button | `handlePanelButton`   |
| `ticket_modal:<dept>`                                                      | Open-ticket form modal  | `handleTicketModal`   |
| `ticket_claim` / `ticket_claim:<dept>` / `ticket_claim:<dept>:<claimerId>` | Claim/release button    | `handleClaim`         |
| `ticket_addmember_btn` / `ticket_addmember_btn:<dept>`                     | Add-user button         | `handleAddUserButton` |
| `ticket_addmember_select`                                                  | User-select menu        | `handleAddUserSelect` |
| `ticket_close` / `ticket_close:<dept>`                                     | Close button            | `handleCloseButton`   |
| `ticket_close_modal` / `ticket_close_modal:<dept>`                         | Close confirm modal     | `handleCloseModal`    |
| `ticket_reopen` / `ticket_reopen:<dept>`                                   | Reopen button           | `handleReopen`        |

Field IDs inside the modals: `subject`, `details` (per the department's `formQuestions`), `ticket_files` (file upload), and `ticket_close_reason` (close reason).

---

## State persistence

`systems/ticketState.js` stores per-thread state in `data/tickets.json` (gitignored runtime state; the `data/` folder is created on first write) keyed by **thread ID**. It holds just enough to re-render the merged card after a restart: `departmentKey`, `openerId`, `openedAt`, the modal `answers`, the `messageId` of the card to edit, `claimedById`, and the closed flags (`closed`, `closedById`, `closedReason`, `closedAt`).

Files dropped into the thread are **not** stored here — Discord keeps them, and the close transcript captures their URLs.
