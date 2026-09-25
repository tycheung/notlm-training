import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TrainAutoControl, TrainAutoControlState } from './types.js';

export function controlPath(trainAutoDir: string): string {
  return join(trainAutoDir, 'control.json');
}

export function readControl(trainAutoDir: string): TrainAutoControl {
  const p = controlPath(trainAutoDir);
  if (!existsSync(p)) {
    return { state: 'running', updatedAt: new Date().toISOString() };
  }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as TrainAutoControl;
  const state: TrainAutoControlState =
    raw.state === 'paused' || raw.state === 'stop' || raw.state === 'running'
      ? raw.state
      : 'running';
  return { state, updatedAt: raw.updatedAt ?? new Date().toISOString(), note: raw.note };
}

export function writeControl(
  trainAutoDir: string,
  state: TrainAutoControlState,
  note?: string
): TrainAutoControl {
  mkdirSync(trainAutoDir, { recursive: true });
  const next: TrainAutoControl = {
    state,
    updatedAt: new Date().toISOString(),
    note,
  };
  writeFileSync(controlPath(trainAutoDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function ensureTrainAutoDir(home: string): string {
  const dir = join(home, 'train-auto');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(controlPath(dir)), { recursive: true });
  return dir;
}

/** Poll until running or stop. Returns false if stop. */
export async function waitWhilePaused(
  trainAutoDir: string,
  opts?: { pollMs?: number; onPause?: () => void }
): Promise<boolean> {
  const pollMs = opts?.pollMs ?? 500;
  for (;;) {
    const c = readControl(trainAutoDir);
    if (c.state === 'stop') return false;
    if (c.state === 'running') return true;
    opts?.onPause?.();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
