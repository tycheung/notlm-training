import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function resolveUipilotHome(dir: string): string {
  const base = dir.replace(/[/\\]+$/, '');
  if (base.split(/[/\\]/).pop() === '.uipilot') return base;
  return join(base, '.uipilot');
}

export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function loadPackJson(home: string, name: string): unknown {
  return readJsonFile(join(home, 'pack', name));
}

export function loadHomeJson(home: string, name: string): unknown {
  return readJsonFile(join(home, name));
}
