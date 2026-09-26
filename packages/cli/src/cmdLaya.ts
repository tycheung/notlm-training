/**
 * `uipilot-training laya convert|train [dir] [--out=…] [--mode=full|light] [--dry-run]`
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertUipilotToLaya, type LayaConvertMode } from '@uipilot-training/laya-train';
import {
  ensureDir,
  pathExists,
  readJsonFile,
  resolveUipilotHome,
  writeJsonFile,
} from './uipilotHome.js';

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positionalDir(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

function trainingRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../..');
}

function parseMode(args: string[]): LayaConvertMode {
  const raw = (parseFlag(args, '--mode') ?? 'full').trim().toLowerCase();
  return raw === 'light' ? 'light' : 'full';
}

export async function cmdLayaConvert(args: string[]): Promise<void> {
  const dir = positionalDir(args) ?? process.cwd();
  const { home } = resolveUipilotHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing UiPilot home: ${home} (run uipilotCLI init)`);
    process.exitCode = 1;
    return;
  }
  const mode = parseMode(args);
  const out =
    parseFlag(args, '--out') ?? join(home, 'laya');
  const { manifest } = convertUipilotToLaya(dir, { mode, out });
  console.log(
    `Laya convert (${mode}): ${manifest.rows} rows → ${manifest.trainPath}\nmanifest: ${manifest.manifestPath}`
  );
}

export async function cmdLayaTrain(args: string[]): Promise<void> {
  const dir = positionalDir(args) ?? process.cwd();
  const { home } = resolveUipilotHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing UiPilot home: ${home} (run uipilotCLI init)`);
    process.exitCode = 1;
    return;
  }
  const mode = parseMode(args);
  const layaDir = parseFlag(args, '--out') ?? join(home, 'laya');
  const checkpointDir = parseFlag(args, '--checkpoint') ?? join(layaDir, 'checkpoint');
  const dryRun =
    hasFlag(args, '--dry-run') || process.env.UIPILOT_LAYA_DRY_RUN === '1';

  const { manifest } = convertUipilotToLaya(dir, { mode, out: layaDir });
  console.log(`Converted ${manifest.rows} rows → ${manifest.trainPath}`);

  const script = join(trainingRepoRoot(), 'scripts', 'laya_train.py');
  const python = process.env.UIPILOT_LAYA_PYTHON ?? 'python';
  const trainArgs = [
    script,
    '--train',
    manifest.trainPath,
    '--out',
    checkpointDir,
    '--mode',
    mode,
  ];
  if (dryRun) trainArgs.push('--dry-run');

  const summary = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const child = spawn(python, trainArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || out.trim() || `laya_train.py exit ${code}`));
        return;
      }
      const line = out.trim().split('\n').pop() ?? '{}';
      try {
        resolvePromise(JSON.parse(line) as Record<string, unknown>);
      } catch {
        reject(new Error(`Invalid laya_train stdout: ${line}`));
      }
    });
  });

  ensureDir(checkpointDir);
  const sidecarPath = join(checkpointDir, 'train-run.json');
  writeJsonFile(sidecarPath, {
    dryRun,
    mode,
    trainPath: manifest.trainPath,
    manifestPath: manifest.manifestPath,
    checkpoint: summary.checkpoint,
    metrics: summary.metrics,
    finishedAt: new Date().toISOString(),
  });

  if (typeof summary.checkpoint === 'string') {
    console.log(`Checkpoint: ${summary.checkpoint}`);
  }
  if (typeof summary.metrics === 'string') {
    const metrics = readJsonFile<Record<string, unknown>>(summary.metrics);
    console.log(`Metrics: ${JSON.stringify(metrics)}`);
  }
  console.log(`Sidecar: ${sidecarPath}`);
}

export async function cmdLaya(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'convert') await cmdLayaConvert(rest);
  else if (sub === 'train') await cmdLayaTrain(rest);
  else {
    console.error('Usage: uipilot-training laya convert|train [dir] [--out=…] [--mode=full|light] [--dry-run]');
    process.exitCode = 1;
  }
}
