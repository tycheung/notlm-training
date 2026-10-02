/**
 * Product training mode: `uipilot-training sharpen`
 * VB System One loop — LLM (or fixture morph) generates N×13 lane prompts,
 * scores against pack, patches language JSON, iterates to hardFails≈0 / 99.9%.
 */
import { join } from 'node:path';
import { createProviderFromEnv } from '@uipilot/llm';
import {
  loadPackJsonFromFolder,
  resolvePackFolder,
  resolveSharpenConfig,
  runSharpenLoop,
  CAPABILITY_LANES,
  type CapabilityLane,
} from '@uipilot/author';
import { resolveUipilotHome, pathExists, ensureDir } from './uipilotHome.js';

function takeFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.findIndex((a) => a === name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

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

export async function cmdSharpen(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home, projectRoot } = resolveUipilotHome(dir);
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

  const reportDir = join(home, 'train-sharpen');
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

  const config = resolveSharpenConfig({
    perLane,
    passRate,
    maxRounds,
    fixture,
    writePack,
    lanes,
  });

  console.log(
    `sharpen pack=${packDir} perLane=${config.perLane} passRate=${config.passRate} fixture=${fixture} lanes=${(lanes || CAPABILITY_LANES).join(',')}`
  );

  const report = await runSharpenLoop({
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
