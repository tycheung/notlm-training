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
      include: [
        'packages/recalibrate/src/**/*.ts',
        'packages/ranker-train/src/**/*.ts',
        'packages/laya-train/src/**/*.ts',
        'packages/author/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        // Live-LLM / soft-label paths — exercised via fixture CLI smoke, not unit coverage.
        'packages/author/src/saturation/generateCandidates.ts',
        'packages/author/src/saturation/softLabel.ts',
        'packages/author/src/saturation/generatePrompt.ts',
        'packages/author/src/saturation/saturateLoop.ts',
        'packages/author/src/saturation/contextTree.ts',
        'packages/author/src/intentsTune.ts',
        'packages/author/src/draftTalk.ts',
        'packages/author/src/parseModelJson.ts',
        'packages/author/src/index.ts',
        // Sharpen LLM generate path — fixture morph + loop covered in unit tests.
        'packages/author/src/capabilityStress/generate.ts',
        // Type-only modules (no runtime statements under v8).
        'packages/laya-train/src/types.ts',
        'packages/author/src/saturation/types.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      '@notlm/core': resolve(__dirname, '../notlm/packages/core/dist/index.js'),
      '@notlm/schema': resolve(__dirname, '../notlm/packages/schema/dist/index.js'),
      '@notlm/ranker': resolve(__dirname, '../notlm/packages/ranker/dist/index.js'),
      '@notlm-training/llm': resolve(__dirname, 'packages/llm/src/index.ts'),
      '@notlm-training/author': resolve(__dirname, 'packages/author/src/index.ts'),
      '@notlm-training/mapper': resolve(__dirname, 'packages/mapper/src/index.ts'),
      '@notlm-training/codegen': resolve(__dirname, 'packages/codegen/src/index.ts'),
      '@notlm-training/recalibrate': resolve(
        __dirname,
        'packages/recalibrate/src/index.ts'
      ),
      '@notlm-training/ranker-train': resolve(
        __dirname,
        'packages/ranker-train/src/index.ts'
      ),
      '@notlm-training/laya-train': resolve(
        __dirname,
        'packages/laya-train/src/index.ts'
      ),
    },
  },
});
