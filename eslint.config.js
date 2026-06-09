// ESLint 9 flat config. Run with:  npm run lint
// Focus is real-bug detection (undefined vars, unreachable code), not style —
// formatting is Prettier's job (npm run format). Noisy rules are warnings so a
// lint run stays useful rather than failing on pre-existing nits.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'config/*.json', 'package-lock.json'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Unused vars/args are a smell but not a hard failure; allow an `_` prefix
      // to explicitly mark intentionally-unused bindings.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty catch blocks are used deliberately for best-effort cleanup.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // The bot logs to the console on purpose.
      'no-console': 'off',
    },
  },
];
