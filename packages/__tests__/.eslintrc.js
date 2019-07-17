module.exports = {
  extends: [
    '../../.eslintrc.js',
    'plugin:cypress/recommended',
    'plugin:mocha/recommended'
  ],
  env: {
    browser: true,
    node: true,
    mocha: true
  },
  plugins: [
    'mocha'
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    'jsdoc/require-jsdoc': 'off',
    'mocha/no-hooks-for-single-case': 'off', // Disabled to avoid duplicates, because 'no-hooks' is enabled
    'sonarjs/cognitive-complexity': 'off',
    'max-lines-per-function': 'off',
    'no-console': 'off',

    // Things we need to fix some day, so are marked as warnings for now:
    'mocha/no-hooks': 'warn',
    'mocha/no-identical-title': 'warn',
    'mocha/no-mocha-arrows': 'warn',

    // Things we still need to decide on:
    'mocha/max-top-level-suites': 'warn',
    'mocha/no-setup-in-describe': 'warn'
  }
};
