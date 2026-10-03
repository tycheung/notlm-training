/**
 * Product training mode #1: `notlm-training auto`
 * Unattended growth: generate → tune → eval → auto ranker retrain.
 * Legacy alias: `train auto`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowStepDef } from '@notlm/core';
import { e2eScenariosFromFlow, glossaryStubsFromControls } from '@notlm/author';
import { cmdTrainAuto, cmdTrainPause, cmdTrainResume, cmdTrainStop } from './cmdTrainAuto.js';
import { cmdRankerTrain } from './cmdRanker.js';
import { resolveNotlmHome, pathExists, loadPackFolderJson } from './notlmHome.js';

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

function positionalDir(args: string[]): string | undefined {
  for (const a of args) {
    if (a.startsWith('--')) continue;
    if (/^\d+(\.\d+)?$/.test(a)) continue;
    return a;
  }
  return undefined;
}

/** Seed E2E + glossary drafts once per home (idempotent). */
function seedAuthoringArtifacts(home: string): void {
  const files = loadPackFolderJson(home);
  const flow = Array.isArray(files.flow) ? (files.flow as FlowStepDef[]) : [];
  if (flow.length) {
    const e2ePath = join(home, 'e2e-scenarios.json');
    if (!existsSync(e2ePath)) {
      writeFileSync(e2ePath, `${JSON.stringify(e2eScenariosFromFlow(flow), null, 2)}\n`);
    }
  }
  const controls = Array.isArray(files.controls) ? files.controls : [];
  if (controls.length) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
    const glossPath = join(home, 'drafts', 'glossary-from-controls.json');
    if (!existsSync(glossPath)) {
      const stubs = glossaryStubsFromControls(controls as never[]);
      if (stubs.length) {
        writeFileSync(glossPath, `${JSON.stringify(stubs, null, 2)}\n`);
      }
    }
  }
}

export async function cmdAuto(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home}`);
    process.exitCode = 1;
    return;
  }

  seedAuthoringArtifacts(home);

  if (hasFlag(args, '--unlimited')) {
    const filtered = args.filter(
      (a) => a !== '--unlimited' && !a.startsWith('--max-iterations')
    );
    filtered.push('--max-iterations=1000000');
    console.log('auto → unlimited mode (stop via `notlm-training auto stop`)');
    await cmdTrainAuto(filtered);
    return;
  }
  await cmdTrainAuto(args);
}

export async function cmdAutoPause(args: string[]): Promise<void> {
  await cmdTrainPause(args);
}

export async function cmdAutoResume(args: string[]): Promise<void> {
  await cmdTrainResume(args);
}

export async function cmdAutoStop(args: string[]): Promise<void> {
  await cmdTrainStop(args);
}

/** Explicit ranker refresh (also runs automatically after tune in auto loop). */
export async function cmdAutoRanker(args: string[]): Promise<void> {
  await cmdRankerTrain(args);
}
