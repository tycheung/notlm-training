import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveActivePackDir } from './notlmHome.js';

describe('resolveActivePackDir', () => {
  it('prefers host pack over manifest-only .notlm/pack stub', () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-pack-resolve-'));
    const home = join(root, '.notlm');
    const nested = join(home, 'pack');
    const hostPack = join(root, 'pack');
    mkdirSync(nested, { recursive: true });
    mkdirSync(hostPack, { recursive: true });
    writeFileSync(join(nested, 'manifest.json'), JSON.stringify({ id: 'stub' }));
    writeFileSync(join(hostPack, 'manifest.json'), JSON.stringify({ id: 'host' }));
    writeFileSync(
      join(hostPack, 'intents.json'),
      JSON.stringify({ aliases: { a: ['open a'] } })
    );
    const resolvePackFolder = (projectRoot: string) => join(projectRoot, '.notlm', 'pack');
    expect(resolveActivePackDir(home, root, resolvePackFolder)).toBe(hostPack);
  });

  it('uses nested pack when it has a language surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-pack-nested-'));
    const home = join(root, '.notlm');
    const nested = join(home, 'pack');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'manifest.json'), JSON.stringify({ id: 'nested' }));
    writeFileSync(
      join(nested, 'intents.json'),
      JSON.stringify({ aliases: { a: ['open a'] } })
    );
    const resolvePackFolder = () => join(root, 'missing-pack');
    expect(resolveActivePackDir(home, root, resolvePackFolder)).toBe(nested);
  });
});
