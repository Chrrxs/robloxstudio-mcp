/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  // The pinned renderer and its staged build are not test packages.
  modulePathIgnorePatterns: ['<rootDir>/vendor/', '<rootDir>/.local/'],
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
