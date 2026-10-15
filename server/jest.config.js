module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // setupFiles runs before any module is loaded, so these env vars are in
  // place before src/config reads process.env (dotenv never overwrites
  // variables that are already set).
  setupFiles: ['<rootDir>/tests/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 30000,
  collectCoverageFrom: ['src/**/*.js', '!src/config/db.js'],
  verbose: true,
  forceExit: true,
  detectOpenHandles: false,
};