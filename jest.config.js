/**
 * Jest configuration for SSEGateway
 *
 * Configured for ESM support with TypeScript using ts-jest.
 * Requires Node.js to be run with --experimental-vm-modules flag.
 */

export default {
  // Use ts-jest preset for ESM
  preset: 'ts-jest/presets/default-esm',

  // Test environment
  testEnvironment: 'node',

  // Module file extensions
  moduleFileExtensions: ['ts', 'js', 'json'],

  // Transform TypeScript files with ts-jest
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },

  // Treat .ts files as ESM
  extensionsToTreatAsEsm: ['.ts'],

  // Module name mapper for ESM imports (handle .js extensions in imports)
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  // Test match patterns
  testMatch: ['**/__tests__/**/*.test.ts'],

  // Coverage configuration
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],

  // Clear mocks between tests
  clearMocks: true,

  // Verbose output
  verbose: true,

  // Force Jest to exit after all tests complete
  forceExit: true,

  // Run tests serially to avoid race conditions in shared state (connections Map)
  maxWorkers: 1,
};
