const base = require('./jest.config');

module.exports = {
  ...base,
  testPathIgnorePatterns: [
    ...base.testPathIgnorePatterns,
    '/test/carga_facil.spec.ts'
  ]
};
