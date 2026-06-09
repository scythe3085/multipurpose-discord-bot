# Verification System

The verification system gates server access behind a button-driven human check. A member clicks **Verify**, passes a set of automated security checks (account age, raid throttling, and — for suspiciously fast clickers — a one-word "type this word" challenge), and is granted a configured **Verified** role. Every outcome can be mirrored to a verify log channel.

Source files:

- `systems/verify.js` — runtime logic (panel, button, modal, role grant, logging)
- `commands/verify.js` — the `/verify` slash command
- `config/verify.config.js` — static tuning (panel copy, account-age gate, raid protection, word list)
- Per-guild config keys are read via `systems/guildConfig.js` (`getVerifyConfig`)

Per-server roles and channels are set **in Discord** with `/config` — see [Configuration](./config-and-whitelist.md). The security thresholds and panel text are set in the static config file and require a code edit + restart to change.

---

## How it works (flow)

1. An admin runs `/verify panel` in the channel where the verify message should live. The bot posts a Components V2 panel with the rules and a green **Verify** button.
2. A member clicks the button (custom ID `verify_button`).
3. The bot runs **pre-checks** (`runPreChecks`):
   - **Bot accounts** are blocked outright.
   - **Raid lock** — if the per-guild raid lock is active, the click is refused with a "try again in X" message.
   - **Raid recording** — the click is recorded toward the raid-protection window; if it pushes the guild over the threshold, the lock engages and the click is refused.
   - **Already verified** — if the member already has the Verified role, they're told so.
   - **Account age** — if the Discord account is younger than `MIN_ACCOUNT_AGE_MS`, the click is hard-rejected.
4. **Suspicion gate** — if the member joined the server less than `MIN_JOIN_AGE_MS` ago (a "fast clicker"), they are **not** rejected; instead they get a **word-challenge modal** asking them to type a random word. Members who lurked for at least that window are verified directly.
5. On success (`grantVerifiedRole`), the bot adds the Verified role, sends an ephemeral "You have been verified!" reply, and logs a success embed.

The word challenge is **case-insensitive** and the modal embeds the expected word in its custom ID. On submit, the account-age and raid checks are re-run (without recording a second raid attempt) before the role is granted.

> Note: the suspicion gate only triggers when `WORD_CHALLENGE.ENABLED` is `true`. If it is disabled, a fast clicker is verified directly with no extra friction.

---

## The slash command

| Command   | Subcommand | Who        | Effect                                        |
| --------- | ---------- | ---------- | --------------------------------------------- |
| `/verify` | `panel`    | Admin only | Posts the verify panel in the current channel |

`/verify panel` checks `PermissionFlagsBits.Administrator` on the caller and refuses non-admins. The panel itself (title, intro, rule blocks, help text, button label/color) is built entirely from the `PANEL` object in `config/verify.config.js`.

```text
/verify panel
```

---

## Per-guild configuration (`/config`)

Two per-server settings drive this system. Set them with `/config quick-setup` (which sets both verified role and verify log together) or the individual `set-*` subcommands. View current values with `/config show`.

| Setting            | `/config` subcommand        | quick-setup option | guildConfig key      | Required?                                         |
| ------------------ | --------------------------- | ------------------ | -------------------- | ------------------------------------------------- |
| Verified role      | `/config set-verified-role` | `verified_role`    | `verifiedRoleId`     | Yes — verification cannot grant a role without it |
| Verify log channel | `/config set-verify-log`    | `verify_log`       | `verifyLogChannelId` | Optional                                          |

Notes:

- **Verified role** is the role added on success. If it is unset (or the role no longer exists on the server), the button replies with an error telling the user to ask an admin to run `/config quick-setup` or `/config set-verified-role`. Make sure the bot's own role is **above** the Verified role in the role list, or `member.roles.add` will fail with a permissions error.
- **Verify log channel** is where verification events are sent. If it is unset, `getVerifyConfig` **falls back to the ticket log channel** (`ticketLogChannelId`). If neither is set, logging is silently skipped.

See [Configuration](./config-and-whitelist.md) for the full `/config` reference.

---

## Security tuning (`config/verify.config.js`)

These are static values baked into the code — change them in the file and restart the process. There are no env vars or `/config` options for them.

### Account age gate

| Key                           | Default            | Meaning                                                            |
| ----------------------------- | ------------------ | ------------------------------------------------------------------ |
| `SECURITY.MIN_ACCOUNT_AGE_MS` | `3 * 24h` (3 days) | Minimum Discord **account** age to verify. Hard reject below this. |

`MIN_ACCOUNT_AGE_MS` is the single source of truth — the panel rule text ("must be at least N days old") is derived from it, so changing the constant updates both the rule copy and the rejection message.

### Join-age suspicion gate + word challenge

| Key                               | Default           | Meaning                                                                                                                                |
| --------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SECURITY.MIN_JOIN_AGE_MS`        | `30 * 1000` (30s) | If the member clicks Verify within this window of **joining the server**, they get the word challenge instead of instant verification. |
| `SECURITY.WORD_CHALLENGE.ENABLED` | `true`            | Master switch for the word challenge.                                                                                                  |
| `SECURITY.WORD_CHALLENGE.WORDS`   | 15-word list      | Pool of short, unambiguous words shown one at a time.                                                                                  |

### Raid protection (per-guild)

A verify storm in one server cannot lock verification in another — raid state is tracked per guild.

| Key                                     | Default                 | Meaning                                                      |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `SECURITY.RAID_PROTECTION.ENABLED`      | `true`                  | Master switch.                                               |
| `SECURITY.RAID_PROTECTION.WINDOW_MS`    | `10 * 1000` (10s)       | Rolling window counted for attempts.                         |
| `SECURITY.RAID_PROTECTION.MAX_ATTEMPTS` | `15`                    | More than this many attempts in the window engages the lock. |
| `SECURITY.RAID_PROTECTION.LOCKOUT_MS`   | `3 * 60 * 1000` (3 min) | How long verification is paused once locked.                 |

### Logging

| Key                  | Default | Meaning                                                                                                                                                                                               |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECURITY.LOG_FAILS` | `true`  | When `true`, failures and intermediate events (too-new accounts, challenges issued/failed, raid triggers) are logged in addition to successes. Successful verifications are always logged regardless. |

---

## Logged events

Verification events are sent as embeds (footer `Verify system`) to the verify log channel — or the ticket log channel as a fallback. The set of events:

| Title                                              | Severity | When                                                      |
| -------------------------------------------------- | -------- | --------------------------------------------------------- |
| `✅ Verified` / `✅ Verified (via word challenge)` | success  | Role granted (always logged)                              |
| `🤖 Bot account blocked`                           | warning  | A bot account clicked Verify                              |
| `🚫 Verify rejected — account too new`             | warning  | Below `MIN_ACCOUNT_AGE_MS` (only if `LOG_FAILS`)          |
| `⏱ Word challenge issued`                          | info     | Fast clicker shown the challenge (only if `LOG_FAILS`)    |
| `❌ Word challenge failed`                         | fail     | Wrong word typed (only if `LOG_FAILS`)                    |
| `🚨 Raid protection triggered`                     | fail     | Guild crossed the attempt threshold (only if `LOG_FAILS`) |

---

## Custom IDs

If you extend or theme the system, these are the identifiers the router (`handleVerifyInteraction`) keys on:

| Custom ID                  | Component                   | Source                                                                            |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| `verify_button`            | Verify panel button         | `PANEL.buttonCustomId` in `config/verify.config.js`                               |
| `verify_word_modal:<word>` | Word-challenge modal        | Built in `buildWordChallengeModal`; the expected word is appended after the colon |
| `verify_word_input`        | Text input inside the modal | Read via `interaction.fields.getTextInputValue`                                   |

The router matches the button by exact custom ID and the modal by the `verify_word_modal:` prefix.

---

## Quick setup checklist

1. Create a **Verified** role and make sure the bot's role sits **above** it.
2. Run `/config quick-setup` (sets `verified_role` and, optionally, `verify_log`) — or `/config set-verified-role` and `/config set-verify-log` individually.
3. Run `/verify panel` in your gate channel as an admin.
4. (Optional) Tune `config/verify.config.js` thresholds and restart the bot.
5. Confirm the bot has **Manage Roles** permission and that channel permissions hide everything except the verify channel until the Verified role is granted.

---

See also: [Configuration](./config-and-whitelist.md) · [Tickets](./tickets.md) · [Setup](../setup.md)
