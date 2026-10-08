/**
 * Checkpoint host pack + e2eauto state before each learn write.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PackJsonInput } from '@notlm/core';
import { writePackFolder } from '../capabilityStress/patch.js';
import { EMPTY_GRADES } from './grade.js';
import type { E2eAutoState, E2eGrade } from './types.js';

export function e2eReportDir(home: string): string {
  return join(home, 'train-e2eauto');
}

export function loadE2eState(reportDir: string): E2eAutoState {
  const path = join(reportDir, 'state.json');
  if (!existsSync(path)) {
    return {
      round: 0,
      lessons: 0,
      cursor: 0,
      seenIds: [],
      lastGradeCounts: EMPTY_GRADES(),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as E2eAutoState;
  } catch {
    return {
      round: 0,
      lessons: 0,
      cursor: 0,
      seenIds: [],
      lastGradeCounts: EMPTY_GRADES(),
      updatedAt: new Date().toISOString(),
    };
  }
}

export function saveE2eState(reportDir: string, state: E2eAutoState): void {
  mkdirSync(reportDir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(join(reportDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

export function appendGradeLog(
  reportDir: string,
  row: Record<string, unknown>
): void {
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, 'grades.jsonl');
  writeFileSync(path, `${JSON.stringify(row)}\n`, { flag: 'a' });
}

/**
 * Snapshot pack folder (+ optional scenario banks) before mutating.
 * Returns checkpoint directory path.
 */
export function checkpointPack(input: {
  reportDir: string;
  packDir: string;
  home: string;
  lesson: number;
  pack: PackJsonInput;
  meta?: Record<string, unknown>;
}): string {
  const dest = join(input.reportDir, 'checkpoint', String(input.lesson).padStart(5, '0'));
  mkdirSync(dest, { recursive: true });
  const packSnap = join(dest, 'pack');
  mkdirSync(packSnap, { recursive: true });
  // Prefer copying live pack tree when present; else write from memory.
  if (existsSync(input.packDir)) {
    cpSync(input.packDir, packSnap, { recursive: true });
  } else {
    writePackFolder(packSnap, input.pack);
  }
  for (const name of [
    'faq-scenarios.json',
    'cb-handoff-scenarios.json',
    'scenarios.json',
  ]) {
    const src = join(input.home, name);
    if (existsSync(src)) {
      cpSync(src, join(dest, name));
    }
  }
  writeFileSync(
    join(dest, 'meta.json'),
    `${JSON.stringify(
      {
        lesson: input.lesson,
        at: new Date().toISOString(),
        ...(input.meta || {}),
      },
      null,
      2
    )}\n`
  );
  return dest;
}

export function bumpGradeCount(
  counts: Record<E2eGrade, number>,
  grade: E2eGrade
): Record<E2eGrade, number> {
  return { ...counts, [grade]: (counts[grade] || 0) + 1 };
}
