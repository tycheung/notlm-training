/**
 * CLI: notlm-training auto
 * System One lane stress — LLM (or fixture morph) generates N×13 lane prompts,
 * scores against pack, patches language JSON, iterates to hardFails=0 / 99.9%.
 * Subcommand: `auto ranker` for explicit pack/ranker.json retrain.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowStepDef } from '@notlm/core';
import { createProviderFromEnv } from '@notlm-training/llm';
import {
  e2eScenariosFromFlow,
  glossaryStubsFromControls,
  loadPackJsonFromFolder,
  resolvePackFolder,
  resolveAutoConfig,
  runAutoLoop,
  CAPABILITY_LANES,
  type CapabilityLane,
} from '@notlm-training/author';
import { cmdRankerTrain } from './cmdRanker.js';
import {
  resolveNotlmHome,
  pathExists,
  loadPackFolderJson,
  ensureDir,
} from './notlmHome.js';
import { takeFlag, hasFlag, positionalDir } from './cliFlags.js';

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
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home}`);
    process.exitCode = 1;
    return;
  }

  seedAuthoringArtifacts(home);

  const packDir = resolvePackFolder(
    pathExists(join(home, 'pack', 'manifest.json')) ? home : projectRoot
  );
  if (!pathExists(join(packDir, 'manifest.json'))) {
    console.error(`Missing pack manifest under ${packDir}`);
    process.exitCode = 1;
    return;
  }

  const fixture = hasFlag(args, '--fixture');
  const writePack = !hasFlag(args, '--no-write');
  const perLane = Number(takeFlag(args, '--per-lane') ?? (fixture ? 5 : 5000));
  const passRate = Number(takeFlag(args, '--pass-rate') ?? 0.999);
  const maxRounds = Number(takeFlag(args, '--max-rounds') ?? 20);
  const lanesFlag = takeFlag(args, '--lanes');
  const lanes = lanesFlag
    ? (lanesFlag.split(',').map((s) => s.trim()).filter(Boolean) as CapabilityLane[])
    : undefined;
  if (lanes) {
    for (const l of lanes) {
      if (!(CAPABILITY_LANES as readonly string[]).includes(l)) {
        console.error(`Unknown lane: ${l}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const reportDir = join(home, 'train-auto');
  ensureDir(reportDir);

  const pack = loadPackJsonFromFolder(packDir);
  let provider = null;
  if (!fixture) {
    try {
      provider = createProviderFromEnv();
    } catch (err) {
      console.error(
        `LLM provider required (or pass --fixture): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      process.exitCode = 1;
      return;
    }
  }

  const config = resolveAutoConfig({
    perLane,
    passRate,
    maxRounds,
    fixture,
    writePack,
    lanes,
  });

  console.log(
    `auto pack=${packDir} perLane=${config.perLane} passRate=${config.passRate} fixture=${fixture} lanes=${(lanes || CAPABILITY_LANES).join(',')}`
  );

  const report = await runAutoLoop({
    pack,
    packDir,
    reportDir,
    provider,
    config,
    onLog: (msg) => console.log(msg),
  });

  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        stopReason: report.stopReason,
        rounds: report.rounds,
        passRate: report.final.passRate,
        hardFails: report.final.hardFails,
        total: report.final.total,
        report: join(reportDir, 'report.json'),
      },
      null,
      2
    )
  );
  if (!report.ok) process.exitCode = 1;
}

/** Explicit ranker refresh (nightly / after pack growth). */
export async function cmdAutoRanker(args: string[]): Promise<void> {
  await cmdRankerTrain(args);
}
