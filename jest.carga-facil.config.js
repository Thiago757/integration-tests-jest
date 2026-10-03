const base = require('./jest.config');

module.exports = {
  ...base,
  testMatch: ['**/test/carga_facil.spec.ts'],
  reporters: [...base.reporters, '<rootDir>/scripts/sonar-reporter.cjs']
};
