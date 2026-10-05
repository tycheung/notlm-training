/**
 * `notlm-training laya convert|train [dir] [--out=…] [--mode=full|light] [--dry-run]`
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { convertNotlmToLaya, layaTrainScriptPath, type LayaConvertMode } from '@notlm-training/laya-train';
import {
  ensureDir,
  pathExists,
  readJsonFile,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';
import { hasFlag, parseFlag, positionalDirFirst } from './cliFlags.js';

function parseMode(args: string[]): LayaConvertMode {
  const raw = (parseFlag(args, '--mode') ?? 'full').trim().toLowerCase();
  return raw === 'light' ? 'light' : 'full';
}

export async function cmdLayaConvert(args: string[]): Promise<void> {
  const dir = positionalDirFirst(args) ?? process.cwd();
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }
  const mode = parseMode(args);
  const out =
    parseFlag(args, '--out') ?? join(home, 'laya');
  const { manifest } = convertNotlmToLaya(dir, { mode, out });
  console.log(
    `Laya convert (${mode}): ${manifest.rows} rows → ${manifest.trainPath}\nmanifest: ${manifest.manifestPath}`
  );
}

export async function cmdLayaTrain(args: string[]): Promise<void> {
  const dir = positionalDirFirst(args) ?? process.cwd();
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }
  const mode = parseMode(args);
  const layaDir = parseFlag(args, '--out') ?? join(home, 'laya');
  const checkpointDir = parseFlag(args, '--checkpoint') ?? join(layaDir, 'checkpoint');
  const dryRun =
    hasFlag(args, '--dry-run') || process.env.NOTLM_LAYA_DRY_RUN === '1';

  const { manifest } = convertNotlmToLaya(dir, { mode, out: layaDir });
  console.log(`Converted ${manifest.rows} rows → ${manifest.trainPath}`);

  const script = layaTrainScriptPath();
  const python = process.env.NOTLM_LAYA_PYTHON ?? 'python';
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
    console.error('Usage: notlm-training laya convert|train [dir] [--out=…] [--mode=full|light] [--dry-run]');
    process.exitCode = 1;
  }
}
