// pm2 process definition. Start with:  pm2 start ecosystem.config.cjs
// Reload after a pull with:            pm2 restart multipurpose-discord-bot
//
// NOTE: instances MUST stay at 1. The bot keeps in-process state (alert poll
// timers, the guild whitelist, the SQLite handle) and is not cluster-safe —
// running multiple instances would double-post alerts and race on writes.
//
// Environment comes from `.env` (loaded by dotenv in index.js), so no secrets
// live in this file. It is safe to commit.

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
