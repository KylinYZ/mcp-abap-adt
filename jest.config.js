/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coveragePathIgnorePatterns: ['/node_modules/', '/__tests__/'],
  coverageThreshold: {
    './src/config/RuntimeGuardrails.ts': { statements: 95, branches: 85, lines: 95 },
    './src/lib/ToolExecutionGate.ts': { statements: 100, branches: 90, functions: 100, lines: 100 },
    './src/lib/requestLimits.ts': { statements: 95, branches: 90, lines: 95 },
    './src/lib/sourceCache.ts': { statements: 90, branches: 85, lines: 90 },
    './src/safe/ChangePlanStore.ts': { statements: 90, lines: 90 }
  },
  verbose: true
};
