import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { IntentParsePack } from '@uipilot/core';
import type { LlmProvider } from '@uipilot/llm';
import {
  appendToVectorStore,
  diversityGate,
  loadVectorStore,
  saveVectorStore,
  vectorsPath,
} from './diversity.js';
import {
  ensureTrainAutoDir,
  readControl,
  waitWhilePaused,
  writeControl,
} from './control.js';
import { makeEvalItem } from './evalUtterance.js';
import { fixtureGenerateBatch, llmGenerateBatch, type GeneratedCandidate } from './generate.js';
import { planNextAction, preferTuneBeforeEval } from './planner.js';
import { deriveWorkerCount, mapPool, withinBudget } from './resources.js';
import {
  appendEvalItems,
  deriveWindowSize,
  emptyRollingState,
  scoreRolling,
} from './stats.js';
import { collectInventoryGuideIds, guardDagMutation } from './dagGuard.js';
import { ALIAS_SOFT_CAP } from '../limits.js';
import type {
  EvalItem,
  RollingEvalState,
  TrainAutoConfig,
  TrainAutoReport,
} from './types.js';

export type PackIO = {
  home: string;
  loadPack: () => Record<string, unknown>;
  asIntentPack: (files: Record<string, unknown>) => IntentParsePack | null;
  /** Persist intents.json (+ optional scenarios) via accept-gated draft. */
  acceptIntentsMerge: (aliasesDelta: Record<string, string[]>, scenarios?: unknown[]) => Promise<{
    ok: boolean;
    draftId?: string;
    errors?: string[];
  }>;
  /** Retrain pack/ranker.json after pack growth (optional). */
  retrainRanker?: () => Promise<{ ok: boolean; detail?: string }>;
};

export type RunTrainAutoInput = {
  home: string;
  packIo: PackIO;
  provider: LlmProvider | null;
  config: TrainAutoConfig;
  onLog?: (msg: string) => void;
  /** Injected sleep for pause polling in tests. */
  pollMs?: number;
};

type PendingPool = {
  candidates: Array<GeneratedCandidate & { id: string }>;
  /** Last batch merged into intents — scored on next eval. */
  lastTuned: Array<GeneratedCandidate & { id: string }>;
};

function trainPaths(dir: string) {
  return {
    rolling: join(dir, 'rolling.json'),
    pending: join(dir, 'pending.json'),
    report: join(dir, 'report.json'),
    state: join(dir, 'state.json'),
  };
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function resolveTrainAutoConfig(partial: Partial<TrainAutoConfig> & {
  passRate?: number;
  confidence?: number;
  window?: number;
}): TrainAutoConfig {
  const passRate = partial.passRate ?? 0.99;
  const confidence = partial.confidence ?? 0.99;
  const window = partial.window ?? deriveWindowSize(passRate, confidence);
  const maxCpu = partial.maxCpu ?? 0.8;
  const maxRam = partial.maxRam ?? 0.8;
  const workers =
    partial.workers ??
    deriveWorkerCount({ maxCpu, maxRam, explicitWorkers: partial.workers });
  return {
    passRate,
    confidence,
    window,
    maxCpu,
    maxRam,
    workers,
    fixture: partial.fixture ?? false,
    resume: partial.resume ?? false,
    maxIterations: partial.maxIterations ?? 10_000,
    diversityMaxSimilarity: partial.diversityMaxSimilarity ?? (partial.fixture ? 0.98 : 0.92),
    diversityMinLexicalNovelty:
      partial.diversityMinLexicalNovelty ?? (partial.fixture ? 0.08 : 0.15),
  };
}

function seedFromScenarios(
  files: Record<string, unknown>,
  pack: IntentParsePack,
  rolling: RollingEvalState
): RollingEvalState {
  const scenarios = files.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) return rolling;
  const items: EvalItem[] = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const row = scenarios[i] as Record<string, unknown>;
    const utterance = typeof row.utterance === 'string' ? row.utterance : null;
    if (!utterance) continue;
    const expectObj =
      row.expect && typeof row.expect === 'object'
        ? (row.expect as Record<string, unknown>)
        : null;
    let expectStep: string | null | undefined;
    if (expectObj && 'stepId' in expectObj) {
      expectStep =
        expectObj.stepId === null || expectObj.stepId === undefined
          ? null
          : String(expectObj.stepId);
    } else if (typeof row.stepId === 'string') {
      expectStep = row.stepId;
    } else if (row.expectStepId === null) {
      expectStep = null;
    } else if (typeof row.expectStepId === 'string') {
      expectStep = row.expectStepId;
    } else if (typeof row.expectedStepId === 'string') {
      expectStep = row.expectedStepId;
    } else {
      continue;
    }
    items.push(
      makeEvalItem(utterance, { stepId: expectStep }, pack, `scenario-${i}`)
    );
  }
  if (!items.length) return rolling;
  return appendEvalItems(rolling, items);
}

export async function runTrainAuto(input: RunTrainAutoInput): Promise<TrainAutoReport> {
  const log = input.onLog ?? ((m: string) => console.log(m));
  const dir = ensureTrainAutoDir(input.home);
  const paths = trainPaths(dir);
  const config = input.config;

  if (!input.config.resume) {
    writeControl(dir, 'running', 'train auto start');
  } else {
    const c = readControl(dir);
    if (c.state === 'stop') writeControl(dir, 'running', 'resume after stop');
    else if (c.state === 'paused') writeControl(dir, 'running', 'resume');
  }

  let rolling: RollingEvalState = readJson(
    paths.rolling,
    emptyRollingState(config.passRate, config.confidence, config.window)
  );
  rolling = {
    ...rolling,
    passRate: config.passRate,
    confidence: config.confidence,
    window: config.window,
  };
  rolling = scoreRolling(rolling);

  let pending: PendingPool = readJson(paths.pending, {
    candidates: [],
    lastTuned: [],
  });
  if (!pending.lastTuned) pending.lastTuned = [];
  let vectors = loadVectorStore(vectorsPath(dir));
  const lastActions: string[] = readJson(paths.state, { lastActions: [] as string[] })
    .lastActions ?? [];

  const files0 = input.packIo.loadPack();
  const pack0 = input.packIo.asIntentPack(files0);
  if (!pack0) {
    throw new Error('pack/ requires flow.json and intents.json');
  }
  if (!input.config.resume || rolling.items.length === 0) {
    rolling = seedFromScenarios(files0, pack0, rolling);
    writeJson(paths.rolling, rolling);
  }

  // Install SIGINT → pause (once).
  const onSig = () => {
    writeControl(dir, 'paused', 'SIGINT');
    log('Paused (SIGINT). Resume with: uipilot-training train resume');
  };
  if (typeof process !== 'undefined' && process.on) {
    process.on('SIGINT', onSig);
  }

  let iterations = 0;
  let stoppedReason: TrainAutoReport['stoppedReason'] = 'max-iterations';

  try {
    while (iterations < config.maxIterations) {
      const okContinue = await waitWhilePaused(dir, {
        pollMs: input.pollMs ?? 400,
        onPause: () => log('…paused'),
      });
      if (!okContinue) {
        stoppedReason = 'stop';
        break;
      }

      const budget = withinBudget({ maxCpu: config.maxCpu, maxRam: config.maxRam });
      if (!budget.ok) {
        log(`Resource budget: ${budget.reason} — sleeping`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      rolling = scoreRolling(rolling);
      if (rolling.met) {
        stoppedReason = 'met';
        log(
          `Met target: passRate=${rolling.lastPassRate.toFixed(4)} wilson=${(rolling.wilsonLower ?? 0).toFixed(4)} window=${rolling.window}`
        );
        break;
      }

      const files = input.packIo.loadPack();
      const pack = input.packIo.asIntentPack(files);
      if (!pack) throw new Error('pack disappeared');

      const planRaw = await planNextAction({
        provider: input.provider,
        fixture: config.fixture,
        iteration: iterations,
        stepIds: pack.steps.map((s) => s.id),
        rolling,
        lastActions,
      });
      const pendingPositives = pending.candidates.filter((c) => c.expectStepId).length;
      const plan = preferTuneBeforeEval(planRaw, pendingPositives);
      lastActions.push(plan.action);
      if (lastActions.length > 40) lastActions.splice(0, lastActions.length - 40);
      log(`#${iterations} plan=${plan.action} — ${plan.rationale}`);

      if (plan.action === 'noop') {
        iterations += 1;
        if (rolling.met) {
          stoppedReason = 'met';
          break;
        }
        continue;
      }

      if (plan.action === 'generate') {
        const batchSize = plan.params?.batchSize ?? 8;
        const includeNegatives = plan.params?.includeNegatives !== false;
        const prior = [
          ...vectors.items.map((v) => v.utterance),
          ...pending.candidates.map((c) => c.utterance),
        ];
        const raw = config.fixture || !input.provider
          ? fixtureGenerateBatch({
              pack,
              batchSize,
              includeNegatives,
              iteration: iterations,
              prior,
            })
          : await llmGenerateBatch({
              provider: input.provider,
              pack,
              batchSize,
              includeNegatives,
              prior,
            });

        const accepted: PendingPool['candidates'] = [];
        for (const c of raw) {
          const gate = diversityGate({
            utterance: c.utterance,
            store: vectors,
            priorUtterances: prior,
            maxSimilarity: config.diversityMaxSimilarity,
            minLexicalNovelty: config.diversityMinLexicalNovelty,
          });
          if (!gate.accept) {
            log(`  reject candidate: ${gate.reason}`);
            continue;
          }
          const id = `c-${iterations}-${accepted.length}`;
          vectors = appendToVectorStore(vectors, c.utterance, id);
          accepted.push({ ...c, id });
          prior.push(c.utterance);
        }
        pending.candidates.push(...accepted);
        saveVectorStore(vectorsPath(dir), vectors);
        writeJson(paths.pending, pending);
        log(`  accepted ${accepted.length}/${raw.length} diverse candidates`);
      } else if (plan.action === 'label') {
        // Soft labels already carried as expectStepId from generate.
        log(`  pending labeled pool size=${pending.candidates.length}`);
      } else if (plan.action === 'tune') {
        const aliasesDelta: Record<string, string[]> = {};
        const scenarioRows: unknown[] = [];
        for (const c of pending.candidates) {
          if (c.expectStepId) {
            const list = aliasesDelta[c.expectStepId] ?? [];
            list.push(c.utterance);
            aliasesDelta[c.expectStepId] = list;
            scenarioRows.push({
              utterance: c.utterance,
              stepId: c.expectStepId,
              id: c.id,
            });
          } else {
            scenarioRows.push({
              utterance: c.utterance,
              stepId: null,
              expectStepId: null,
              id: c.id,
              negative: true,
            });
          }
        }
        if (Object.keys(aliasesDelta).length === 0) {
          log('  tune skipped — no positive pending aliases');
        } else {
          const result = await input.packIo.acceptIntentsMerge(aliasesDelta, scenarioRows);
          if (!result.ok) {
            log(`  tune failed: ${(result.errors ?? []).join('; ')}`);
          } else {
            log(`  tune accepted draft ${result.draftId}`);
            pending.lastTuned = [...pending.candidates];
            pending.candidates = [];
            writeJson(paths.pending, pending);
            if (input.packIo.retrainRanker) {
              const r = await input.packIo.retrainRanker();
              log(
                r.ok
                  ? `  ranker: auto-retrained after tune (${r.detail ?? 'ok'})`
                  : `  ranker: auto-retrain skipped (${r.detail ?? 'fail'})`
              );
            }
          }
        }
      } else if (plan.action === 'dag') {
        const inventory = existsSync(join(input.home, 'inventory.json'))
          ? JSON.parse(readFileSync(join(input.home, 'inventory.json'), 'utf8'))
          : null;
        const ids = collectInventoryGuideIds(inventory);
        const guard = guardDagMutation({
          inventoryGuideIds: ids,
          flow: files.flow,
          controls: files.controls,
        });
        if (!guard.ok) {
          log(`  dag skipped: ${guard.errors.join('; ')}`);
        } else {
          log('  dag: inventory OK — structural author left to pack author (no-op this turn)');
        }
      } else if (plan.action === 'eval') {
        const packNow = input.packIo.asIntentPack(input.packIo.loadPack())!;
        const toScore =
          pending.lastTuned.length > 0
            ? pending.lastTuned
            : pending.candidates.length > 0
              ? pending.candidates
              : NEGATIVE_FALLBACK.map((utterance, i) => ({
                  id: `neg-${iterations}-${i}`,
                  utterance,
                  expectStepId: null as string | null,
                  kind: 'negative' as const,
                }));

        const scored = await mapPool(toScore, config.workers, async (c) =>
          makeEvalItem(
            c.utterance,
            { stepId: c.expectStepId },
            packNow,
            c.id
          )
        );
        rolling = appendEvalItems(rolling, scored);
        writeJson(paths.rolling, rolling);
        if (pending.lastTuned.length) {
          pending.lastTuned = [];
          writeJson(paths.pending, pending);
        }
        const passN = scored.filter((s) => s.passed).length;
        log(
          `  eval ${passN}/${scored.length} batch; rolling=${rolling.lastPassRate.toFixed(4)} (${Math.min(rolling.items.length, rolling.window)}/${rolling.window}) wilson=${(rolling.wilsonLower ?? 0).toFixed(4)}`
        );
      } else if (plan.action === 'ranker') {
        if (input.packIo.retrainRanker) {
          const r = await input.packIo.retrainRanker();
          log(
            r.ok
              ? `  ranker: retrained (${r.detail ?? 'ok'})`
              : `  ranker: retrain failed (${r.detail ?? 'unknown'})`
          );
        } else {
          log('  ranker: no retrainRanker hook on PackIO');
        }
      }

      writeJson(paths.state, { lastActions, iteration: iterations });
      iterations += 1;
    }
  } catch (err) {
    stoppedReason = 'error';
    log(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (typeof process !== 'undefined' && process.off) {
      process.off('SIGINT', onSig);
    }
  }

  rolling = scoreRolling(rolling);
  if (rolling.met) stoppedReason = 'met';

  const report: TrainAutoReport = {
    stoppedReason,
    iterations,
    rolling,
    config,
    finishedAt: new Date().toISOString(),
  };
  writeJson(paths.report, report);
  writeJson(paths.rolling, rolling);
  return report;
}

const NEGATIVE_FALLBACK = [
  'give me a recipe for a tomato sandwich',
  'what is the capital of Mongolia',
  'sing me a lullaby',
];

/** Helper used by CLI to merge aliases into pack via drafts. */
export function mergeAliasesIntoIntents(
  intents: { aliases?: Record<string, string[]>; meta?: string[]; [k: string]: unknown },
  delta: Record<string, string[]>,
  softCap = ALIAS_SOFT_CAP
): typeof intents {
  const aliases = { ...(intents.aliases ?? {}) };
  for (const [stepId, phrases] of Object.entries(delta)) {
    const existing = new Set((aliases[stepId] ?? []).map((p) => p.toLowerCase()));
    const next = [...(aliases[stepId] ?? [])];
    for (const p of phrases) {
      if (next.length >= softCap) break;
      if (!existing.has(p.toLowerCase())) {
        next.push(p);
        existing.add(p.toLowerCase());
      }
    }
    aliases[stepId] = next.slice(0, softCap);
  }
  return { ...intents, aliases };
}

export function writeAcceptDraft(input: {
  home: string;
  draftId: string;
  intents: unknown;
  scenarios?: unknown;
  corpus?: unknown;
}): string {
  const draftDir = join(input.home, 'drafts', input.draftId);
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, 'intents.json'), `${JSON.stringify(input.intents, null, 2)}\n`);
  if (input.scenarios !== undefined) {
    writeFileSync(
      join(draftDir, 'scenarios.json'),
      `${JSON.stringify(input.scenarios, null, 2)}\n`
    );
  }
  if (input.corpus !== undefined) {
    writeFileSync(join(draftDir, 'corpus.json'), `${JSON.stringify(input.corpus, null, 2)}\n`);
  }
  writeFileSync(
    join(draftDir, 'meta.json'),
    `${JSON.stringify({ checked: true, kind: 'train-auto', createdAt: new Date().toISOString() }, null, 2)}\n`
  );
  return draftDir;
}

/** Copy pack piece for backup before accept (CLI may call cmdPackAccept). */
export function backupPackFile(home: string, name: string, destDir: string): void {
  const src = join(home, 'pack', name);
  if (existsSync(src)) {
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, join(destDir, name));
  }
}
