/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      '@uipilot/core': resolve(__dirname, '../uipilot/packages/core/dist/index.js'),
      '@uipilot/schema': resolve(__dirname, '../uipilot/packages/schema/dist/index.js'),
      '@uipilot-training/recalibrate': resolve(
        __dirname,
        'packages/recalibrate/src/index.ts'
      ),
    },
  },
});
