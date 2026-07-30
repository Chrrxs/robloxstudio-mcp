/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'esnext',
        target: 'esnext',
        lib: ['esnext'],
        esModuleInterop: true,
        moduleResolution: 'node',
      },
    }],
  },
  testMatch: [
    '<rootDir>/tests/creator-store-sanitization-policy.test.ts',
  ],
  testTimeout: 30000,
};
