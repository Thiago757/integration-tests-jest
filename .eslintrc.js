module.exports = {
  root: true,
  env: {
    node: true
  },
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  overrides: [
    {
      files: ['scripts/*.cjs', 'jest.*.config.js'],
      rules: { '@typescript-eslint/no-var-requires': 'off' }
    }
  ]
};
