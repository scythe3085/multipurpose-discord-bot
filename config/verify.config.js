// config/verify.config.js

// Single source of truth for the account-age gate. The panel rule text below
// and the runtime rejection message both derive from this, so changing it can't
// leave the UI lying about the requirement.
const MIN_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MIN_ACCOUNT_AGE_DAYS = Math.round(MIN_ACCOUNT_AGE_MS / (24 * 60 * 60 * 1000));

module.exports = {
  SECURITY: {
    // Discord account must be at least this old to verify
    MIN_ACCOUNT_AGE_MS,

    // Server-join age suspicion gate. If a user clicks Verify within this
    // window after joining the server, they are NOT rejected outright — they
    // are asked to type a short random word back. Frictionless for users who
    // lurk for half a minute first; defeats join-and-instaclick automation.
    MIN_JOIN_AGE_MS: 30 * 1000,

    // Word challenge — shown only when a user fails the join-age suspicion gate.
    WORD_CHALLENGE: {
      ENABLED: true,
      // Short, easy to type, unambiguous. Avoid lookalikes (I/l, O/0).
      WORDS: [
        'BANANA',
        'ROCKET',
        'COFFEE',
        'PIRATE',
        'BISCUIT',
        'TIGER',
        'GUITAR',
        'CASTLE',
        'FOREST',
        'PLANET',
        'MEADOW',
        'TURTLE',
        'PEPPER',
        'WIZARD',
        'CANDLE',
      ],
    },

    LOG_FAILS: true,

    RAID_PROTECTION: {
      ENABLED: true,
      WINDOW_MS: 10 * 1000, // look at last 10s
      MAX_ATTEMPTS: 15, // more than 15 attempts -> lock
      LOCKOUT_MS: 3 * 60 * 1000, // lock verification for 3 mins
    },
  },

  PANEL: {
    title: '🛡 Verify to Access the Server',
    intro:
      'Welcome in! To keep the community safe from raids and botted accounts, ' +
      'we use a quick automated check. Most people pass it instantly.',
    rules: [
      {
        name: '📅 Account age',
        value: `Your Discord account must be at least **${MIN_ACCOUNT_AGE_DAYS} days old**.`,
      },
      {
        name: '⏱ Settle in for a moment',
        value:
          'If you click immediately after joining, you will be asked to type a quick word ' +
          'to confirm you are human. Lurking for half a minute first skips this.',
      },
    ],
    helpText: 'If you get stuck, please contact staff.',
    buttonLabel: '✅ Verify',
    buttonCustomId: 'verify_button',
    accentColor: 0x57f287,
  },
};
