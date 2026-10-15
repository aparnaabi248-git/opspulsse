const globals = require('globals');

/**
 * ESLint flat configuration for the OpsPulse backend.
 * Run with:  npm run lint
 */
module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', '*.config.js'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // The logger and the CLI entry point are allowed to write to the console
    files: ['src/config/logger.js', 'server.js'],
    rules: { 'no-console': 'off' },
  },
];