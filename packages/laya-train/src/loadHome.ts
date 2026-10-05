import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNotlmHomeDir } from '@notlm/core/loadFolder';

export function resolveNotlmHome(dir: string): string {
  return resolveNotlmHomeDir(dir).home;
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
