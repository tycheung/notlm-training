/**
 * Shared post-steps for `train` and `feedback` entry points:
 * semantic embed (on drift) → ranker (on drift) → optional Laya (--laya=1).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenarioCase } from '@notlm/core';
import {
  decideRankerRetrain,
  decideSemanticRebuild,
  loadPackJsonFromFolder,
  writeSemanticBaseIndex,
  type PipelineState,
  type SemanticIndexWithDigest,
} from '@notlm-training/author';
import { cmdRankerTrain } from './cmdRanker.js';
import { cmdLaya } from './cmdLaya.js';
import { exited } from './cliExit.js';
import { pathExists, unwrapCatalogArray } from './notlmHome.js';

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Fail loud when a required pack/home JSON file is corrupt (do not treat as empty). */
function readJsonOrThrow(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(
      `Invalid JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function pipelineStatePath(home: string): string {
  return join(home, 'pipeline-state.json');
}

export function loadPipelineState(home: string): PipelineState {
  return readJsonSafe<PipelineState>(pipelineStatePath(home)) ?? {};
}

export function savePipelineState(home: string, state: PipelineState): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    pipelineStatePath(home),
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  );
}

export type PipelinePostOpts = {
  home: string;
  packDir: string;
  projectRoot: string;
  forceRanker?: boolean;
  /** When true with forceRanker, no_labeled_examples fails the post (CI / --force-ranker). */
  requireRanker?: boolean;
  laya?: boolean;
  layaDryRun?: boolean;
  skipEmbed?: boolean;
  skipRanker?: boolean;
};

export type PipelinePostResult = {
  ok: boolean;
  embed: { ran: boolean; reason: string };
  ranker: { ran: boolean; reason: string };
  laya: { ran: boolean; reason: string };
};

/**
 * Apply drift-gated embed + ranker, then optional Laya.
 * On embed failure, ranker/Laya are skipped so digests stay consistent.
 */
export async function runPipelinePost(
  opts: PipelinePostOpts
): Promise<PipelinePostResult> {
  const pack = loadPackJsonFromFolder(opts.packDir);
  const state = loadPipelineState(opts.home);
  const result: PipelinePostResult = {
    ok: true,
    embed: { ran: false, reason: 'skipped' },
    ranker: { ran: false, reason: 'skipped' },
    laya: { ran: false, reason: 'skipped' },
  };

  if (!opts.skipEmbed) {
    const indexPath = join(opts.packDir, 'semantic-index.json');
    const index = existsSync(indexPath)
      ? readJsonSafe<SemanticIndexWithDigest>(indexPath)
      : null;
    const decision = decideSemanticRebuild(pack, index);
    result.embed.reason = decision.reason;
    if (decision.needed) {
      try {
        const written = writeSemanticBaseIndex(opts.packDir, pack);
        state.semanticSourceDigest = written.sourceDigest;
        result.embed.ran = true;
        console.log(
          `pipeline → semantic base index rebuilt (${decision.reason}, ${written.docs.length} docs)`
        );
      } catch (err) {
        result.ok = false;
        result.embed.reason = `failed: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`pipeline → semantic rebuild failed: ${result.embed.reason}`);
        console.error('pipeline → skipping ranker/laya after embed failure');
        savePipelineState(opts.home, state);
        process.exitCode = 1;
        return result;
      }
    } else {
      console.log(`pipeline → semantic index ok (${decision.reason})`);
      if (index?.sourceDigest) {
        state.semanticSourceDigest = index.sourceDigest;
      }
    }
  }

  // Persist digests after successful embed so a later Laya throw cannot drop them.
  savePipelineState(opts.home, state);

  if (!opts.skipRanker) {
    const corpusPath = join(opts.packDir, 'corpus.json');
    let corpus: ScenarioCase[] = [];
    let scenarios: ScenarioCase[] = [];
    try {
      corpus = existsSync(corpusPath)
        ? (unwrapCatalogArray(readJsonOrThrow(corpusPath), 'corpus') as ScenarioCase[])
        : [];
      const scenariosHome = join(opts.home, 'scenarios.json');
      scenarios = existsSync(scenariosHome)
        ? (unwrapCatalogArray(readJsonOrThrow(scenariosHome), 'scenarios') as ScenarioCase[])
        : [];
    } catch (err) {
      result.ok = false;
      result.ranker.reason = `failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`pipeline → ranker inputs invalid: ${result.ranker.reason}`);
      console.error('pipeline → skipping laya after ranker input failure');
      savePipelineState(opts.home, state);
      process.exitCode = 1;
      return result;
    }
    const hasRanker = pathExists(join(opts.packDir, 'ranker.json'));
    const decision = decideRankerRetrain({
      pack,
      corpus,
      scenarios,
      hasRankerJson: hasRanker,
      state,
      force: opts.forceRanker,
    });
    result.ranker.reason = decision.reason;
    if (decision.needed) {
      console.log(`pipeline → ranker retrain (${decision.reason})`);
      const prevExit = process.exitCode;
      process.exitCode = 0;
      try {
        await cmdRankerTrain([opts.projectRoot]);
      } catch (err) {
        result.ok = false;
        result.ranker.reason = `failed: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`pipeline → ranker threw: ${result.ranker.reason}`);
        console.error('pipeline → skipping laya after ranker failure');
        savePipelineState(opts.home, state);
        process.exitCode = 1;
        return result;
      }
      if (exited()) {
        result.ok = false;
        result.ranker.reason = `failed (${decision.reason})`;
        console.error('pipeline → ranker retrain failed; digest not stamped');
        console.error('pipeline → skipping laya after ranker failure');
        savePipelineState(opts.home, state);
        process.exitCode = 1;
        return result;
      }
      state.rankerSourceDigest = decision.digest;
      result.ranker.ran = true;
      savePipelineState(opts.home, state);
      if (prevExit) process.exitCode = prevExit;
    } else {
      if (decision.reason === 'no_labeled_examples') {
        console.log(
          'pipeline → ranker skipped (no_labeled_examples; existing ranker.json unchanged)'
        );
        if (opts.forceRanker && opts.requireRanker) {
          result.ok = false;
          result.ranker.reason = 'no_labeled_examples';
          console.error('pipeline → skipping laya after requireRanker failure');
          savePipelineState(opts.home, state);
          process.exitCode = 1;
          return result;
        }
      } else {
        console.log(`pipeline → ranker ok (${decision.reason})`);
      }
    }
  }

  if (opts.laya) {
    result.laya.reason = 'laya_flag';
    const layaArgs = [opts.projectRoot, '--mode=light'];
    if (opts.layaDryRun) layaArgs.push('--dry-run');
    console.log(
      `pipeline → laya ${opts.layaDryRun ? 'convert/dry-run' : 'convert+train'} (--laya=1)`
    );
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      await cmdLaya(['train', ...layaArgs]);
      if (exited()) {
        result.ok = false;
        result.laya.reason = 'failed';
        console.error('pipeline → laya failed');
      } else {
        result.laya.ran = true;
        if (prevExit) process.exitCode = prevExit;
      }
    } catch (err) {
      result.ok = false;
      result.laya.reason = `failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`pipeline → laya threw: ${result.laya.reason}`);
      process.exitCode = 1;
    }
  } else {
    result.laya.reason = 'laya_flag_off';
  }

  savePipelineState(opts.home, state);
  if (!result.ok) process.exitCode = 1;
  return result;
}

/** Parse `--laya=1` / `--laya` / `--laya=true`. */
export function wantsLaya(args: string[]): boolean {
  if (args.includes('--laya') || args.includes('--laya=1') || args.includes('--laya=true')) {
    return true;
  }
  const eq = args.find((a) => a.startsWith('--laya='));
  if (!eq) return false;
  const v = eq.slice('--laya='.length).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
