/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@uipilot/core': resolve(__dirname, '../uipilot/packages/core/dist/index.js'),
      '@uipilot/schema': resolve(__dirname, '../uipilot/packages/schema/dist/index.js'),
    },
  },
});
